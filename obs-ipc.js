// Obsidian 相关 IPC 处理器（主进程与测试共用）
const { ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

function register() {
  // 选择 Obsidian 库文件夹
  ipcMain.handle('obs:pickVault', async () => {
    const r = await dialog.showOpenDialog({
      title: '选择 Obsidian 库文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  // 在资源管理器中打开文件夹
  ipcMain.handle('obs:openFolder', (e, p) => {
    if (p && fs.existsSync(p)) shell.openPath(p);
  });

  // 通过 obsidian:// URI 在 Obsidian 中打开笔记
  ipcMain.handle('obs:openInObsidian', (e, { vaultPath, rel }) => {
    const vaultName = path.basename(vaultPath || '');
    const file = (rel || '').replace(/\.md$/i, '');
    const uri = 'obsidian://open?vault=' + encodeURIComponent(vaultName) + '&file=' + encodeURIComponent(file);
    shell.openExternal(uri);
  });

  // 扫描库内所有 .md 文件（递归，跳过隐藏目录/.obsidian/.trash）
  ipcMain.handle('obs:scan', (e, root) => {
    if (!root || !fs.existsSync(root)) return { error: '路径不存在' };
    const files = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        if (ent.name === 'node_modules') continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === '.obsidian' || ent.name === '.trash') continue;
          walk(full);
        } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
          try {
            const st = fs.statSync(full);
            const content = fs.readFileSync(full, 'utf8');
            files.push({
              rel: full.slice(root.length + 1).replace(/\\/g, '/'),
              name: ent.name,
              words: content.replace(/\s/g, '').length,
              mtime: st.mtimeMs
            });
          } catch { /* 忽略无法读取的文件 */ }
        }
      }
    };
    walk(root);
    return { files, vault: root };
  });

  // 写入 / 追加笔记
  ipcMain.handle('obs:write', (e, { file, content, append }) => {
    try {
      if (append) fs.appendFileSync(file, '\n' + content, 'utf8');
      else fs.writeFileSync(file, content, 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}

module.exports = { register };
