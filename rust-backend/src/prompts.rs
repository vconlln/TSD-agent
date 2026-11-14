//! 提示词外置 + 热重载。
//!
//! 为什么不用 include_str!：改一句 prompt 就要重新编译，维护成本太高。
//! 这里从 <可执行文件同级>/prompts 或环境变量 TSD_PROMPTS_DIR 读取 .md，
//! 读不到就用内置默认值；文件改动按 mtime 自动生效，进程不用重启。

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::SystemTime,
};

const DEFAULTS: &[(&str, &str)] = &[
    ("agent", DEFAULT_AGENT),
    ("chat", DEFAULT_CHAT),
    ("inline-edit", DEFAULT_INLINE_EDIT),
    ("inline-explain", DEFAULT_INLINE_EXPLAIN),
    ("coder", DEFAULT_CODER),
];

static CACHE: Mutex<Option<HashMap<String, (SystemTime, String)>>> = Mutex::new(None);

fn prompts_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("TSD_PROMPTS_DIR") {
        let path = PathBuf::from(dir);
        if path.is_dir() {
            return Some(path);
        }
    }
    // 1) <exe 同级>/prompts（打包后）
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let path = parent.join("prompts");
            if path.is_dir() {
                return Some(path);
            }
        }
    }
    // 2) 源码树里的 rust-backend/prompts（开发时）
    let local = Path::new(env!("CARGO_MANIFEST_DIR")).join("prompts");
    if local.is_dir() {
        return Some(local);
    }
    None
}

fn default_for(name: &str) -> &'static str {
    DEFAULTS
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, text)| *text)
        .unwrap_or("")
}

/// 取提示词：优先外部文件（改动按 mtime 生效），否则内置默认
pub fn get(name: &str) -> String {
    let Some(dir) = prompts_dir() else {
        return default_for(name).to_string();
    };
    let path = dir.join(format!("{name}.md"));
    let Ok(meta) = std::fs::metadata(&path) else {
        return default_for(name).to_string();
    };
    let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);

    if let Ok(mut guard) = CACHE.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        if let Some((stamp, text)) = cache.get(name) {
            if *stamp == modified {
                return text.clone();
            }
        }
        if let Ok(text) = std::fs::read_to_string(&path) {
            let text = text.trim().to_string();
            if !text.is_empty() {
                cache.insert(name.to_string(), (modified, text.clone()));
                return text;
            }
        }
    }
    default_for(name).to_string()
}

pub const DEFAULT_AGENT: &str = "你是一名资深软件工程师，在真实代码库里完成升级改造任务。\
你可以调用工具读文件、搜索、修改文件、运行命令。\
铁律：\n\
1. 不要凭空猜测代码内容：修改前先用 read_file 或 grep 确认原文；\n\
2. 一次只做一小步，改完立刻回读或跑测试确认；\n\
3. edit_file 的 old_string 必须与文件内容逐字一致（含缩进）；\n\
4. 改完必须运行测试/类型检查（run_tests 或 run_command），失败要读错误并修复；\n\
5. 不要执行 git push/commit、不要改项目外的文件、不要安装全局依赖；\n\
6. 任务完成时调用 finish 工具，用中文总结改了什么、为什么、验证结果。";

pub const DEFAULT_CHAT: &str = "你是 TSD Agent 的项目升级助手，正在和工程师对话。\
你熟悉这个项目的原始方案、升级方案与升级后的代码库。\n\n\
工作方式：\n\
1. 涉及具体实现时，先用 list_files / read_file / grep 核实，不要凭印象作答；\n\
2. 要改代码时用 propose_edit 提交完整文件内容，用户会在界面上审阅后决定是否应用；\n\
3. 回答用简体中文，结构清晰但不啰嗦；代码与路径保持原样；\n\
4. 不要编造文件内容或测试结果；\n\
5. 不需要改代码时直接回答，不要调用 propose_edit。";

pub const DEFAULT_CODER: &str = "你是资深软件工程师，负责把一个既有项目按升级方案改造。只输出 JSON，不要输出解释性文字或 Markdown 代码围栏。保持项目原有代码风格与接口兼容，改动范围要小且必要。";

pub const DEFAULT_INLINE_EDIT: &str = "你是资深工程师，负责在一个既有代码库里精确修改用户选中的代码。\
只输出 JSON，不要输出解释性文字或 Markdown 代码围栏。\
replacement 必须是可直接替换选中行的完整代码文本，保持一致缩进与引号风格。";

pub const DEFAULT_INLINE_EXPLAIN: &str = "你是资深工程师，负责向同事解释一段代码。\
用简体中文输出 Markdown：先一句话结论，再分点说明作用、关键逻辑、潜在风险或改进点。\
不要复述整段代码，不要使用二级以上标题。";
