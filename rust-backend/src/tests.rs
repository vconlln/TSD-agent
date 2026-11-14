use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use crate::diff::{compute_diffs, markdown_sections, patch_for, plan_diff};

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tsd-rs-test-{}-{}", tag, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn patch_counts_additions_and_deletions() {
    let (patch, additions, deletions, truncated) = patch_for("a\nb\n", "a\nc\n", "x.txt");
    assert!(patch.contains("--- a/x.txt"), "补丁要有 from 头: {patch}");
    assert!(patch.contains("+++ b/x.txt"), "补丁要有 to 头");
    assert!(patch.contains("@@"), "补丁要有 hunk 头");
    assert_eq!(additions, 1);
    assert_eq!(deletions, 1);
    assert!(!truncated);
}

#[test]
fn identical_text_has_empty_patch() {
    let (patch, additions, deletions, _) = patch_for("same\n", "same\n", "x.txt");
    assert!(patch.is_empty(), "内容一致时不应产生补丁: {patch}");
    assert_eq!(additions, 0);
    assert_eq!(deletions, 0);
}

#[test]
fn markdown_sections_split_on_heading_and_skip_code_fences() {
    let fence = "```";
    let text = format!("# 一\n正文\n\n## 二\n{fence}\n# 代码里的井号\n{fence}\n结尾\n");
    let sections = markdown_sections(&text);
    assert_eq!(sections.len(), 2, "两个标题应切成两段");
    assert_eq!(sections[0].level, 1);
    assert_eq!(sections[0].heading, "一");
    assert_eq!(sections[1].level, 2);
    assert!(sections[1].text.contains("代码里的井号"), "代码块里的 # 不应被当成标题");
}

#[test]
fn plan_diff_marks_added_modified_removed() {
    let old = "# 目标\n旧内容\n\n## 已删除\n内容\n";
    let new = "# 目标\n新内容\n\n## 新增\n内容\n";
    let diff = plan_diff(old, new);
    let sections = diff["sections"].as_array().unwrap();
    let statuses: Vec<&str> = sections.iter().map(|s| s["status"].as_str().unwrap()).collect();
    assert!(statuses.contains(&"modified"), "目标章节应标记 modified: {statuses:?}");
    assert!(statuses.contains(&"added"), "新章节应标记 added");
    assert!(statuses.contains(&"removed"), "消失的章节应标记 removed");
}

#[test]
fn compute_diffs_detects_add_modify_delete_and_rename() {
    let root = temp_dir("diffs");
    let a = root.join("a");
    let b = root.join("b");
    fs::create_dir_all(a.join("src")).unwrap();
    fs::create_dir_all(b.join("src")).unwrap();
    fs::write(a.join("src/keep.ts"), "export const keep = 1\n").unwrap();
    fs::write(b.join("src/keep.ts"), "export const keep = 2\n").unwrap();
    fs::write(a.join("src/gone.ts"), "gone\n").unwrap();
    fs::write(b.join("src/added.ts"), "added\n").unwrap();
    fs::write(a.join("src/old-name.ts"), "same body\n").unwrap();
    fs::write(b.join("src/new-name.ts"), "same body\n").unwrap();

    let result = compute_diffs(&a, &b);
    let by_path: BTreeMap<&str, &str> = result.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect();
    assert_eq!(by_path.get("src/keep.ts"), Some(&"modified"));
    assert_eq!(by_path.get("src/added.ts"), Some(&"added"));
    assert_eq!(by_path.get("src/gone.ts"), Some(&"deleted"));
    assert_eq!(by_path.get("src/new-name.ts"), Some(&"renamed"), "内容相同的改名应识别为重命名");
    assert_eq!(result.stats.files_changed, 4);
    let _ = fs::remove_dir_all(&root);
}
