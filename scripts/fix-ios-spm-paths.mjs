#!/usr/bin/env node
/**
 * fix-ios-spm-paths.mjs
 *
 * 修掉 Capacitor CLI 在 Windows 上生成 `ios/App/CapApp-SPM/Package.swift` 时
 * 写入反斜杠路径的问题。
 *
 * ---------------------------------------------------------------------------
 * 问题是什么
 * ---------------------------------------------------------------------------
 * CLI 里生成 SPM 清单的代码（node_modules/@capacitor/cli/dist/util/spm.js）
 * 用的是 path.relative()，且**没有**包一层 convertToUnixPath()：
 *
 *     const relPath = relative(config.ios.nativeXcodeProjDirAbs, plugin.rootPath);
 *     packageSwiftText += `,\n        .package(name: "${plugin.name}", path: "${relPath}")`;
 *
 * 在 macOS / Linux 上 path.relative() 返回正斜杠，一切正常；
 * 在 Windows 上返回反斜杠，于是生成出这样一行 Swift：
 *
 *     .package(name: "FoliaAudioSession", path: "..\..\..\native\ios-plugin")
 *
 * 而 Swift 字符串字面量里 `\n` 是转义字符（换行），`\.` 更是非法转义序列 ——
 * 这个文件在 macOS 上根本编译不过。
 *
 * 对照：同一个 CLI 的 ios/update.js 在 Podfile 相关代码里是包了
 * convertToUnixPath() 的，所以这是 CLI 自身的疏漏，不是我们的用法问题。
 *
 * ---------------------------------------------------------------------------
 * 为什么 CI 上不出事，但仍要修
 * ---------------------------------------------------------------------------
 * CI 跑在 macos-latest 上，`npx cap sync ios` 会重新生成这个文件，
 * 那时 path.relative() 返回正斜杠，结果是对的。
 *
 * 但仓库里提交的那份是 Windows 生成的（坏文件）：
 *   - 在 Mac 上直接 xcodebuild（没先跑 sync）会编译失败
 *   - 任何跳过了 cap sync 的构建路径都会踩到
 * 所以这里把它规范化，让「仓库里的文件」在任何平台都是对的。
 *
 * 用法：
 *   node scripts/fix-ios-spm-paths.mjs
 *   幂等：已经是正斜杠时不做任何改动。
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageSwiftPath = join(projectRoot, 'ios', 'App', 'CapApp-SPM', 'Package.swift');

const fileExists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const main = async () => {
  if (!(await fileExists(packageSwiftPath))) {
    console.log('· 没有 ios/App/CapApp-SPM/Package.swift，跳过（先跑 npx cap add ios）');
    return;
  }

  const original = await readFile(packageSwiftPath, 'utf8');

  // 只动 `.package(... path: "...")` 里的那个字符串，别碰别的。
  // 这样即使将来 Swift 文件里出现别的反斜杠（比如正则字面量）也不会被误伤。
  let fixedCount = 0;
  const patched = original.replace(
    /(\.package\([^)]*?path:\s*")([^"]*)(")/g,
    (_match, prefix, pathValue, suffix) => {
      if (!pathValue.includes('\\')) return _match;
      fixedCount += 1;
      return `${prefix}${pathValue.replace(/\\/g, '/')}${suffix}`;
    },
  );

  if (fixedCount === 0) {
    console.log('· CapApp-SPM/Package.swift 路径已是正斜杠，无需修改');
    return;
  }

  await writeFile(packageSwiftPath, patched, 'utf8');
  console.log(`✓ 修正了 ${fixedCount} 处反斜杠路径：ios/App/CapApp-SPM/Package.swift`);

  // 回读确认：文件里不该再有任何反斜杠路径
  const reread = await readFile(packageSwiftPath, 'utf8');
  const remaining = reread.match(/path:\s*"[^"]*\\[^"]*"/g);
  if (remaining) {
    console.error('✗ 仍有未修正的路径：', remaining);
    process.exitCode = 1;
  }
};

await main();
