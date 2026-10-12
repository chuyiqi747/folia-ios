#!/usr/bin/env node
// ============================================================================
// verify-ios-plugin.mjs
//
// 校验 folia-audio-session 原生插件是否被 Capacitor 正确注册。
//
// 为什么需要这个脚本：
//   插件注册失败是【静默】的 —— Xcode 编译完全正常，App 也能跑，
//   只有运行时 JS 调 NativeAudioSession.activate() 会 reject，
//   表现为「锁屏没信息、后台不播」，很难定位。
//   这个脚本把两个关键判据自动化，`npx cap sync ios` 之后跑一次即可。
//
// 用法：
//   node scripts/verify-ios-plugin.mjs
// 或加进 package.json：
//   "cap:sync:ios": "npm run build:capacitor && cap sync ios && node scripts/verify-ios-plugin.mjs"
//
// 退出码：0 = 全部通过；1 = 有失败项（可直接用于 CI）
// ============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const PLUGIN_PKG = 'folia-audio-session';
const SWIFT_CLASS = 'FoliaAudioSessionPlugin'; // Swift 类名，注意带 Plugin 后缀
const SPM_NAME = 'FoliaAudioSession';          // fixName(包名) 的结果

const root = process.cwd();

let failed = 0;
const pass = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg, hint) => {
  failed += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
  if (hint) console.log(`    \x1b[90m→ ${hint}\x1b[0m`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ---------------------------------------------------------------------------
section('1. 插件包是否已安装到 node_modules');
// ---------------------------------------------------------------------------
const pkgDir = resolve(root, 'node_modules', PLUGIN_PKG);
const pkgJsonPath = join(pkgDir, 'package.json');

if (!existsSync(pkgJsonPath)) {
  fail(
    `node_modules/${PLUGIN_PKG} 不存在`,
    '检查根 package.json 是否有 "folia-audio-session": "file:./native/ios-plugin"，然后 npm install'
  );
} else {
  pass(`node_modules/${PLUGIN_PKG} 存在`);

  const pkg = readJSON(pkgJsonPath);
  const iosSrc = pkg?.capacitor?.ios?.src;

  if (iosSrc) {
    pass(`package.json 声明了 capacitor.ios.src = "${iosSrc}"`);
  } else {
    fail(
      'package.json 缺少 capacitor.ios.src',
      'CLI 靠这个字段决定扫哪个目录，缺了插件永远扫不到'
    );
  }

  if (iosSrc && existsSync(join(pkgDir, iosSrc))) {
    pass(`扫描目录 ${iosSrc}/ 存在`);
  } else if (iosSrc) {
    fail(`扫描目录 ${iosSrc}/ 不存在`);
  }

  // SwiftPM 清单 —— 决定 Xcode 能不能编译进这个包
  if (existsSync(join(pkgDir, 'Package.swift'))) {
    const swift = readFileSync(join(pkgDir, 'Package.swift'), 'utf8');
    const nameMatch = swift.match(/name:\s*"([^"]+)"/);
    if (nameMatch && nameMatch[1] === SPM_NAME) {
      pass(`Package.swift 的 package name = "${SPM_NAME}"`);
    } else {
      fail(
        `Package.swift 的 package name 是 "${nameMatch ? nameMatch[1] : '未找到'}"，应为 "${SPM_NAME}"`,
        '必须等于 fixName(包名)。不一致会报 Unknown package ... in dependencies of target'
      );
    }
    if (new RegExp(`library\\(\\s*\\n?\\s*name:\\s*"${SPM_NAME}"`).test(swift)) {
      pass(`Package.swift 导出了同名 library product`);
    } else {
      fail(
        `Package.swift 的 products 里没有名为 "${SPM_NAME}" 的 library`,
        'CLI 生成的是 .product(name: "FoliaAudioSession", package: "FoliaAudioSession")'
      );
    }
  } else {
    fail(
      'Package.swift 不存在',
      'Capacitor 8 用 SPM，插件包必须自带 Package.swift 才会被编译'
    );
  }

  // 不能同时有 Swift 与 ObjC 两套注册（会 duplicate symbol）
  const hasSwift = existsSync(join(pkgDir, iosSrc || 'ios', 'Sources', SPM_NAME, `${SWIFT_CLASS}.swift`));
  if (hasSwift) {
    const swiftFile = join(pkgDir, iosSrc || 'ios', 'Sources', SPM_NAME, `${SWIFT_CLASS}.swift`);
    const src = readFileSync(swiftFile, 'utf8');
    if (src.includes(`@objc(${SWIFT_CLASS})`)) {
      pass(`Swift 里有 @objc(${SWIFT_CLASS})（CLI 正则能扫到，运行时 NSClassFromString 也能找到）`);
    } else {
      fail(
        `Swift 里缺少 @objc(${SWIFT_CLASS})`,
        'CLI 用 /@objc\\(([A-Za-z0-9_-]+)\\)/ 提取类名，没有它插件进不了注册清单'
      );
    }
    if (src.includes('CAPBridgedPlugin')) {
      pass('Swift 实现了 CAPBridgedPlugin 协议');
    } else {
      fail('Swift 未实现 CAPBridgedPlugin', '运行时会 as? CapacitorPlugin 转换失败');
    }
  }
}

// ---------------------------------------------------------------------------
section('2. cap sync 是否生成了插件注册清单');
// ---------------------------------------------------------------------------
const capConfigJson = resolve(root, 'ios', 'App', 'App', 'capacitor.config.json');

if (!existsSync(capConfigJson)) {
  fail(
    'ios/App/App/capacitor.config.json 不存在',
    '还没跑过 npx cap add ios / npx cap sync ios'
  );
} else {
  const cfg = readJSON(capConfigJson);
  const list = cfg.packageClassList || [];
  if (list.includes(SWIFT_CLASS)) {
    pass(`packageClassList 含 ${SWIFT_CLASS}（共 ${list.length} 个插件）`);
  } else {
    fail(
      `packageClassList 里没有 ${SWIFT_CLASS}`,
      'CLI 没扫到插件。确认 node_modules 里真的有这个包，且 capacitor.ios.src 指向的目录里有 .swift 文件'
    );
  }
}

// ---------------------------------------------------------------------------
section('3. Xcode 的 SPM 清单是否引用了插件');
// ---------------------------------------------------------------------------
const capSPM = resolve(root, 'ios', 'App', 'CapApp-SPM', 'Package.swift');

if (!existsSync(capSPM)) {
  fail('ios/App/CapApp-SPM/Package.swift 不存在', '确认 ios.packageManager 是 SPM');
} else {
  const text = readFileSync(capSPM, 'utf8');
  if (new RegExp(`\\.package\\(name:\\s*"${SPM_NAME}"`).test(text)) {
    pass(`Package.swift 里有 .package(name: "${SPM_NAME}", ...)`);
  } else {
    fail(`Package.swift 里没有 .package(name: "${SPM_NAME}")`);
  }
  if (new RegExp(`\\.product\\(name:\\s*"${SPM_NAME}"`).test(text)) {
    pass(`Package.swift 里有 .product(name: "${SPM_NAME}", ...)`);
  } else {
    fail(`Package.swift 里没有 .product(name: "${SPM_NAME}")`);
  }
}

// ---------------------------------------------------------------------------
section('4. Info.plist 的后台音频声明');
// ---------------------------------------------------------------------------
const plist = resolve(root, 'ios', 'App', 'App', 'Info.plist');

if (!existsSync(plist)) {
  fail('ios/App/App/Info.plist 不存在');
} else {
  const text = readFileSync(plist, 'utf8');
  // 宽松匹配：UIBackgroundModes 数组里含 audio
  const hasBgAudio =
    /UIBackgroundModes[\s\S]{0,200}?<string>\s*audio\s*<\/string>/.test(text);
  if (hasBgAudio) {
    pass('Info.plist 含 UIBackgroundModes = [audio]');
  } else {
    fail(
      'Info.plist 缺少 UIBackgroundModes = [audio]',
      '缺了它 AVAudioSession 设成 .playback 也没用，App 一退后台声音就停'
    );
  }
}

// ---------------------------------------------------------------------------
console.log('');
if (failed === 0) {
  console.log('\x1b[32m\x1b[1m全部通过。\x1b[0m 下一步：npx cap open ios，用真机跑（模拟器验不了锁屏）。');
  console.log('\x1b[90m真机验证顺序见 patches/App.tsx-接入点.md 第 6 节。\x1b[0m');
  process.exit(0);
} else {
  console.log(`\x1b[31m\x1b[1m${failed} 项未通过。\x1b[0m`);
  console.log('\x1b[90m完整排查表见 native-audio/ios-plugin/README.md 第六节。\x1b[0m');
  process.exit(1);
}
