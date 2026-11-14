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
// ------------------------- L2：事件中心与运行记录 -------------------------

#[test]
fn event_seq_is_monotonic_per_run_and_history_replays() {
    use crate::events::RunChannel;
    let channel = RunChannel::new("run-a", None);
    let first = channel.emit("run.status", Some(serde_json::json!({ "status": "running" })));
    let second = channel.emit("log", None);
    assert_eq!(first.seq, 1);
    assert_eq!(second.seq, 2);
    assert!(second.seq > first.seq, "seq 必须单调递增");
    assert_eq!(channel.history_since(0).len(), 2);
    assert_eq!(channel.history_since(1).len(), 1, "since=N 只回放 seq > N");
    assert_eq!(channel.history_since(2).len(), 0);
}

#[test]
fn terminal_event_closes_the_channel() {
    use crate::events::RunChannel;
    let channel = RunChannel::new("run-b", None);
    assert!(!channel.is_closed());
    channel.emit("run.done", Some(serde_json::json!({ "summary": "ok" })));
    assert!(channel.is_closed(), "run.done 之后通道应关闭");
}

#[test]
fn run_steps_start_pending_and_record_status() {
    use crate::runs::Run;
    let mut run = Run::new("proj-1", "upgrade", "补日志");
    assert_eq!(run.steps.len(), 7, "创建 run 时就该带 7 个步骤");
    assert!(run.steps.iter().all(|step| step.status == "pending"));
    run.set_step("fetch", "done", Some("已解析".to_string()), None, Some(100));
    let fetch = run.steps.iter().find(|step| step.key == "fetch").unwrap();
    assert_eq!(fetch.status, "done");
    assert_eq!(fetch.progress, Some(100));
    assert!(fetch.finished_at.is_some(), "完成态要写 finishedAt");
}

#[test]
fn events_are_persisted_for_replay_after_restart() {
    use crate::events::RunChannel;
    let dir = temp_dir("events");
    let log = dir.join("run-c.events.jsonl");
    let channel = RunChannel::new("run-c", Some(log.clone()));
    channel.emit("step.status", Some(serde_json::json!({ "key": "fetch" })));
    channel.emit("run.done", None);
    let text = fs::read_to_string(&log).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2, "每条事件都要落盘");
    let parsed: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(parsed["seq"], 1);
    assert_eq!(parsed["type"], "step.status");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn safe_write_path_allows_new_files_and_rejects_escapes() {
    use crate::state::{safe_join, safe_write_path};
    let root = temp_dir("safe-write");
    let target = root.join("v1.0.0");
    fs::create_dir_all(&target).unwrap();

    // 新建嵌套文件是允许的（对话提案会创建 docs/xxx.md）
    let created = safe_write_path(&target, "docs/CHAT_NOTES.md").expect("新文件应可解析");
    assert!(created.starts_with(target.canonicalize().unwrap()));
    let nested = safe_write_path(&target, "./a/b/c.txt").expect("多层新目录应可解析");
    assert!(nested.ends_with("c.txt"));

    // 越界与空路径仍然拒绝
    assert!(safe_write_path(&target, "../evil.txt").is_none(), ".. 必须拒绝");
    assert!(safe_write_path(&target, "").is_none());
    assert!(safe_write_path(&target, "/etc/passwd").is_none() || !safe_write_path(&target, "/etc/passwd").unwrap().starts_with("/etc"));

    // 读路径要求文件已存在，两种语义不能混
    assert!(safe_join(&target, "docs/CHAT_NOTES.md").is_none());
    let _ = fs::remove_dir_all(&root);
}


#[test]
fn toolbox_rejects_escaping_paths_and_dangerous_commands() {
    use crate::toolbox::{glob_match, Toolbox};
    let root = temp_dir("toolbox");
    fs::write(root.join("a.txt"), "hello\n").unwrap();
    let mut box_ = Toolbox::new(&root, true, 4000);
    assert!(glob_match("**/*", "a.txt"));
    assert!(glob_match("*.txt", "a.txt"));
    assert!(!glob_match("*.md", "a.txt"));

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let escape = box_
            .call("read_file", &serde_json::json!({ "path": "../outside.txt" }))
            .await;
        assert!(!escape.ok, "越界路径必须拒绝：{}", escape.content);
        let blocked = box_
            .call("run_command", &serde_json::json!({ "command": "sudo rm -rf /" }))
            .await;
        assert!(!blocked.ok, "危险命令必须拒绝：{}", blocked.content);
        let not_allowed = box_
            .call("run_command", &serde_json::json!({ "command": "curl http://example.com" }))
            .await;
        assert!(!not_allowed.ok, "白名单外命令必须拒绝：{}", not_allowed.content);

        let edit = box_
            .call(
                "edit_file",
                &serde_json::json!({ "path": "a.txt", "old_string": "hello", "new_string": "hello world" }),
            )
            .await;
        assert!(edit.ok, "沙箱内编辑应成功：{}", edit.content);
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "hello world\n");
        assert_eq!(box_.changed_files.len(), 1);

        let missing = box_
            .call(
                "edit_file",
                &serde_json::json!({ "path": "a.txt", "old_string": "not-there", "new_string": "x" }),
            )
            .await;
        assert!(!missing.ok, "old_string 不匹配要给出提示：{}", missing.content);
        assert!(missing.content.contains("未找到完全一致的 old_string"));
    });

    let mut disabled = Toolbox::new(&root, false, 4000);
    runtime.block_on(async {
        let denied = disabled
            .call("run_command", &serde_json::json!({ "command": "node -v" }))
            .await;
        assert!(!denied.ok, "关闭命令执行后要拦截");
    });
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn agent_parses_json_protocol_and_repo_map_lists_symbols() {
    use crate::repomap::{build_repo_map, detect_commands, extract_symbols};
    let root = temp_dir("repomap");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/index.ts"),
        "export function createOrder(id: string) {}\nexport class OrderRepo {}\n",
    )
    .unwrap();
    fs::write(
        root.join("package.json"),
        "{\n  \"name\": \"demo\",\n  \"version\": \"1.0.0\",\n  \"scripts\": { \"test\": \"node -e 0\" }\n}\n",
    )
    .unwrap();

    let symbols = extract_symbols(
        "src/index.ts",
        "export function createOrder() {}\nexport class OrderRepo {}\n",
        10,
    );
    assert!(symbols.contains(&"createOrder".to_string()), "符号抽取：{symbols:?}");
    assert!(symbols.contains(&"OrderRepo".to_string()));

    let map = build_repo_map(&root, 4000, 100);
    assert!(map.contains("仓库共"), "地图要有头部：{map}");
    assert!(map.contains("src/index.ts"), "地图要列出文件：{map}");

    let (test, _, _) = detect_commands(&root);
    assert_eq!(test.as_deref(), Some("npm run test"), "探测 package.json 测试命令");

    // 模型可能把 JSON 包在围栏里：抓对象时必须容忍
    let fence = "\u{60}\u{60}\u{60}";
    let raw = format!("{fence}json\n{{\"tool\":\"read_file\",\"args\":{{\"path\":\"a\"}}}}\n{fence}");
    let parsed = crate::llm::parse_json_object(&raw).expect("围栏内的 JSON 也要能解析");
    assert_eq!(parsed["tool"], serde_json::json!("read_file"));
    let _ = fs::remove_dir_all(&root);
}

