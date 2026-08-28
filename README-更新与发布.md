# 工作站自更新与发布指南

本版本已内置「自动更新」能力：工作站会通过 **GitHub Releases** 检查新版本，
下载新版应用包（`app.asar`）并**原子替换**（备份+回滚），全程支持断点续传、重试与 sha512 校验，
任何一步失败都不会毁坏当前版本（真正“不能断链”）。

---

## 1. 它做了什么
- **检查**：启动 8 秒后 + 每 4 小时，后台静默检查一次（联网失败自动重试，绝不崩溃）。
- **下载**：只更新应用本身（`app.asar`，通常几百 KB），支持断点续传与 sha512 校验。
- **安装**：先备份旧包，再原子替换；失败自动回滚到旧版并提示。
- **不干扰其它功能**：更新器独立后台运行，不影响网络工具箱/性能优化/磁盘清理等任何功能。

## 2. 它如何知道“新版本在哪”
编辑器里维护一个固定配置，默认安装在 `exe` 同目录的 **`update-config.json`**：

```json
{
  "owner": "你的GitHub用户名",
  "repo": "workstation-app",
  "checkIntervalMs": 14400000
}
```

> 复制项目根目录的 `update-config.example.json` 为 `update-config.json`，放到
> 打包后的 `Workstation-win32-x64` 文件夹里（与 `Workstation.exe` 同级），填好 `owner` / `repo`。
> 未配置时应用会提示“未配置 GitHub 仓库”，不会出错。

也可用环境变量临时覆盖：`WORKSTATION_UPDATE_OWNER`、`WORKSTATION_UPDATE_REPO`、`WORKSTATION_UPDATE_API`。

## 3. 第一次发布（把“当前版本”变成可更新的 exe）
1. 把项目推到 GitHub 仓库（`owner/repo` 即为上面的配置）。
   ```bash
   cd workstation-app
   git init
   git add -A
   git commit -m "工作站 自更新版"
   git remote add origin https://github.com/<你的用户名>/workstation-app.git
   git push -u origin main
   ```
2. 发布首个版本，打成 `v1.11.0`（比 `package.json` 的 `1.10.0` 新一个号即可）：
   ```bash
   git tag v1.11.0
   git push origin v1.11.0
   ```
3. GitHub Actions 会自动构建、生成 `latest.json` 与 `workstation-1.11.0.asar`，
   并创建一个 `Release`（见 `.github/workflows/release.yml`）。
4. 把 `update-config.json`（含你的 `owner/repo`）放进打包好的 `Workstation-win32-x64` 文件夹，
   运行 `Workstation.exe`。此时版本为 `1.10.0`，会检测到仓库里有 `v1.11.0`，提示“发现新版本”。

## 4. 以后每次出新版本
1. 改代码。
2. 提升 `package.json` 的 `version`（如 `1.11.0 → 1.12.0`）。
3. 打新 tag 并推送：
   ```bash
   git add -A; git commit -m "v1.12.0"
   git tag v1.12.0
   git push origin main v1.12.0
   ```
4. 所有已安装的工作站会在下次检查时自动下载并更新，无需用户操作。

> 手动（不走 Actions）也可：本地 `npm run pack` → 运行
> `scripts/stage-release.ps1` 生成 `_release/latest.json` 与 asar → 上传为 Release 资产。
> （需 `GITHUB_TOKEN` 环境变量含 `repo` 权限。）

## 5. 本地信息
```bash
npm run pack      # 用 electron-packager 打包（产出 dist/Workstation-win32-x64/Workstation.exe）
npm start         # 开发调试
node scripts/selftest-update.mjs   # 自测“不能断链”核心机制（断点续传/校验/原子替换）
```

> 国内打包提示：`electron-packager` 会联网下载 Electron 运行时，若从 GitHub 很慢卡住，
> 请先设置镜像再打包：
> ```bash
> # PowerShell
> $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'   # 之后 npm run pack
> # bash / Git Bash
> export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   # 之后 npm run pack
> ```

> 提示：国内网络访问 GitHub 可能较慢。若更新源为 GitHub，建议稳定网络（或配置系统可访问）。
> 如需改用其它服务器，把 `update-config.json` 中 `repo` 指向你的托管仓库即可。
