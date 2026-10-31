; TSD Agent 安装向导文案（由 electron-builder 的 nsis.include 引入）。
;
; customWelcomePage 会在 electron-builder 的 assisted installer 中展开，
; 此时完成页（MUI_PAGE_FINISH）尚未插入，因此在这里定义的
; MUI_FINISHPAGE_* 同样会作用于完成页。
;
; 安装器以简体中文构建（nsis.installerLanguages: zh_CN），
; electron-builder 以 -INPUTCHARSET UTF8 调用 makensis，中文可直接书写。

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "安装 TSD Agent"
  !define MUI_WELCOMEPAGE_TEXT "本向导会把 TSD Agent 安装到你的电脑。$\r$\n$\r$\nTSD Agent 把「项目方案升级」做成一条自动化流水线：解析方案页面、下载代码、生成 UPDATE.md、升级代码，并给出可视化差异；装好后还能在编辑器里让 AI 解释或改写选中代码，再新建分支推送 Git。$\r$\n$\r$\n安装会创建桌面快捷方式，也可以自定义安装目录。$\r$\n$\r$\n点击「下一步」继续。"
  !insertmacro MUI_PAGE_WELCOME

  !define MUI_FINISHPAGE_TITLE "TSD Agent 安装完成"
  !define MUI_FINISHPAGE_TEXT "TSD Agent 已安装到：$\r$\n$INSTDIR$\r$\n$\r$\n首次启动会自动拉起本地 Python 引擎（通常 1-2 秒）。随后可在「设置」里配置推理模型，或用 W3 账号登录取访问凭证。$\r$\n$\r$\n祝你升级顺利。"
  !define MUI_FINISHPAGE_RUN_TEXT "立即启动 TSD Agent"
!macroend
