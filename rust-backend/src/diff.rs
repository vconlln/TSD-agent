use std::{collections::BTreeMap, path::Path};

use serde::Serialize;
use serde_json::{json, Value};
use similar::TextDiff;

use crate::store;

const MAX_PATCH_LINES: usize = 2000;
const MAX_FILE_CHARS: usize = 600_000;
const MAX_FILES_IN_DIFF: usize = 3000;

#[derive(Serialize)]
pub struct FileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub patch: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub binary: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct FileStats {
    pub files: usize,
    pub added: u32,
    pub removed: u32,
    #[serde(rename = "filesChanged")]
    pub files_changed: usize,
}

#[derive(Serialize)]
pub struct FileDiffResult {
    pub files: Vec<FileEntry>,
    pub stats: FileStats,
}

/// 统一格式补丁：形状与 difflib.unified_diff 一致（--- a/x / +++ b/x / @@ ... @@）
pub(crate) fn patch_for(a_text: &str, b_text: &str, path: &str) -> (String, u32, u32, bool) {
    let a: String = a_text.chars().take(MAX_FILE_CHARS).collect();
    let b: String = b_text.chars().take(MAX_FILE_CHARS).collect();
    let truncated = a_text.chars().count() > MAX_FILE_CHARS || b_text.chars().count() > MAX_FILE_CHARS;

    let diff = TextDiff::from_lines(&a, &b);
    let unified = diff
        .unified_diff()
        .context_radius(3)
        .header(&format!("a/{}", path), &format!("b/{}", path))
        .to_string();

    let mut additions = 0u32;
    let mut deletions = 0u32;
    let mut lines: Vec<String> = Vec::new();
    for line in unified.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            lines.push(line.to_string());
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
        lines.push(line.to_string());
    }

    if lines.len() > MAX_PATCH_LINES {
        let head: Vec<String> = lines.into_iter().take(MAX_PATCH_LINES).collect();
        return (format!("{}\n@@ 差异过大，已截断 @@", head.join("\n")), additions, deletions, true);
    }
    (lines.join("\n"), additions, deletions, truncated)
}

fn push_entry(
    files: &mut Vec<FileEntry>,
    source_root: &Path,
    target_root: &Path,
    rel: &str,
    status: &str,
    old_path: Option<&str>,
) {
    if files.len() >= MAX_FILES_IN_DIFF {
        return;
    }
    let abs_src = source_root.join(old_path.unwrap_or(rel));
    let abs_tgt = target_root.join(rel);
    if store::is_binary(&abs_tgt) || store::is_binary(&abs_src) {
        files.push(FileEntry {
            path: rel.to_string(),
            old_path: old_path.map(|s| s.to_string()),
            status: status.to_string(),
            additions: 0,
            deletions: 0,
            patch: String::new(),
            binary: true,
            truncated: false,
        });
        return;
    }
    let before = if status == "added" {
        String::new()
    } else {
        store::read_text(&abs_src, MAX_FILE_CHARS * 2).0
    };
    let after = if status == "deleted" {
        String::new()
    } else {
        store::read_text(&abs_tgt, MAX_FILE_CHARS * 2).0
    };
    let (patch, additions, deletions, truncated) = patch_for(&before, &after, rel);
    files.push(FileEntry {
        path: rel.to_string(),
        old_path: old_path.map(|s| s.to_string()),
        status: status.to_string(),
        additions,
        deletions,
        patch,
        binary: false,
        truncated,
    });
}

/// 逐文件比较两棵树：新增 / 删除 / 修改 / 重命名（内容哈希识别）
pub fn compute_diffs(source_root: &Path, target_root: &Path) -> FileDiffResult {
    let source_files = store::walk_files(source_root);
    let target_files = store::walk_files(target_root);

    let only_source: Vec<&String> = source_files.keys().filter(|k| !target_files.contains_key(*k)).collect();
    let only_target: Vec<&String> = target_files.keys().filter(|k| !source_files.contains_key(*k)).collect();
    let mut renamed: BTreeMap<String, String> = BTreeMap::new();
    let mut used: Vec<String> = Vec::new();
    for src in &only_source {
        let src_hash = store::hashed(&source_root.join(src));
        if src_hash == 0 {
            continue;
        }
        for tgt in &only_target {
            if used.iter().any(|u| u == *tgt) {
                continue;
            }
            if store::hashed(&target_root.join(tgt)) == src_hash {
                renamed.insert((*src).clone(), (*tgt).clone());
                used.push((*tgt).clone());
                break;
            }
        }
    }

    let mut files: Vec<FileEntry> = Vec::new();
    // renamed 是「旧路径 → 新路径」，遍历目标侧时要反查，别把方向弄反
    let mut renamed_targets: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (old_rel, new_rel) in &renamed {
        push_entry(&mut files, source_root, target_root, new_rel, "renamed", Some(old_rel));
        renamed_targets.insert(new_rel.clone());
    }
    for rel in target_files.keys() {
        if renamed_targets.contains(rel) {
            continue;
        }
        if !source_files.contains_key(rel) {
            push_entry(&mut files, source_root, target_root, rel, "added", None);
            continue;
        }
        let changed = source_files[rel] != target_files[rel]
            || store::hashed(&source_root.join(rel)) != store::hashed(&target_root.join(rel));
        if changed {
            push_entry(&mut files, source_root, target_root, rel, "modified", None);
        }
    }
    for rel in source_files.keys() {
        if renamed.contains_key(rel) || target_files.contains_key(rel) {
            continue;
        }
        push_entry(&mut files, source_root, target_root, rel, "deleted", None);
    }

    files.sort_by(|a, b| {
        let rank = |s: &str| if s == "modified" { 0 } else { 1 };
        rank(&a.status)
            .cmp(&rank(&b.status))
            .then_with(|| (b.additions + b.deletions).cmp(&(a.additions + a.deletions)))
            .then_with(|| a.path.cmp(&b.path))
    });

    let added = files.iter().map(|f| f.additions).sum();
    let removed = files.iter().map(|f| f.deletions).sum();
    FileDiffResult {
        stats: FileStats {
            files: source_files.len(),
            added,
            removed,
            files_changed: files.len(),
        },
        files,
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Section {
    pub(crate) key: String,
    pub(crate) heading: String,
    pub(crate) level: usize,
    pub(crate) text: String,
}

fn is_fence(line: &str) -> bool {
    line.trim_start().as_bytes().starts_with(&[0x60, 0x60, 0x60])
}

pub(crate) fn markdown_sections(text: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    let mut heading = String::from("前言");
    let mut level = 0usize;
    let mut buffer: Vec<String> = Vec::new();
    let mut in_fence = false;

    fn flush(sections: &mut Vec<Section>, heading: &str, level: usize, buffer: &mut Vec<String>) {
        let body = buffer.join("\n").trim().to_string();
        if !body.is_empty() || level > 0 {
            sections.push(Section {
                key: format!("{}::{}", level, heading),
                heading: heading.to_string(),
                level,
                text: body,
            });
        }
        buffer.clear();
    }

    for line in text.replace("\r\n", "\n").split('\n') {
        if is_fence(line) {
            in_fence = !in_fence;
        }
        let heading_match = if in_fence {
            None
        } else {
            let trimmed = line.trim_start();
            let hashes = trimmed.chars().take_while(|c| *c == '#').count();
            let rest = trimmed[hashes..].trim_start();
            if (1..=6).contains(&hashes) && !rest.is_empty() {
                Some((hashes, rest.trim().to_string()))
            } else {
                None
            }
        };
        match heading_match {
            Some((hashes, text)) => {
                flush(&mut sections, &heading, level, &mut buffer);
                level = hashes;
                heading = text;
            }
            None => buffer.push(line.to_string()),
        }
    }
    flush(&mut sections, &heading, level, &mut buffer);

    sections
        .into_iter()
        .filter(|s| s.heading != "前言" || !s.text.is_empty())
        .collect()
}

pub fn plan_diff(old_text: &str, new_text: &str) -> Value {
    let old_sections = markdown_sections(old_text);
    let new_sections = markdown_sections(new_text);

    let mut sections: Vec<Value> = Vec::new();
    for section in &new_sections {
        let before = old_sections.iter().find(|s| s.key == section.key);
        let status = match before {
            None => "added",
            Some(prev) if prev.text.trim() != section.text.trim() => "modified",
            Some(_) => "unchanged",
        };
        sections.push(json!({
            "key": section.key,
            "heading": section.heading,
            "level": section.level,
            "text": section.text,
            "status": status,
            "oldText": before.map(|s| s.text.clone()).unwrap_or_default(),
            "newText": section.text,
        }));
    }
    for section in &old_sections {
        if new_sections.iter().any(|s| s.key == section.key) {
            continue;
        }
        sections.push(json!({
            "key": section.key,
            "heading": section.heading,
            "level": section.level,
            "text": section.text,
            "status": "removed",
            "oldText": section.text,
        }));
    }

    let (unified, additions, deletions, _) = patch_for(old_text, new_text, "PLAN.md");
    json!({
        "unified": unified,
        "sections": sections,
        "additions": additions,
        "deletions": deletions,
    })
}
