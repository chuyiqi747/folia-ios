import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 当前文件：从 resources/ 的源图反复生成 iOS 图标与浅色/深色启动图。
//
// 与 Android 版的差别：iOS 的 AppIcon 不允许透明通道，且 @capacitor/assets
// 在 iOS 上生成的是 Assets.xcassets 目录结构 + LaunchScreen.storyboard，
// 因此参数从 --android 换成 --ios。
//
// 源图要求（放进 resources/）：
//   icon.png         1024x1024，不透明，无圆角（系统会裁）
//   splash-light.png 2732x2732，浅色主题启动图中心内容
//   splash-dark.png  2732x2732，深色主题启动图中心内容
//
// 建议源图颜色与 Folia 主题一致：
//   浅色背景 #efedf8 / 深色背景 #11142b（与 folia-sonnet 的 Android 资源同值）

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(projectRoot, 'resources');
const stagingRoot = join(projectRoot, '.asset-staging');
const iconStage = join(stagingRoot, 'icon');
const splashStage = join(stagingRoot, 'splash');

const assetsCli = join(
  projectRoot,
  'node_modules',
  '@capacitor',
  'assets',
  'bin',
  'capacitor-assets',
);

const sourceFiles = {
  icon: join(sourceDir, 'icon.png'),
  splashLight: join(sourceDir, 'splash-light.png'),
  splashDark: join(sourceDir, 'splash-dark.png'),
};

// Runs one deterministic Capacitor Assets pass and forwards its output to the caller.
const runAssets = (assetPath, extraArgs = []) => {
  const result = spawnSync(
    process.execPath,
    [assetsCli, 'generate', '--ios', '--assetPath', assetPath, ...extraArgs],
    { cwd: projectRoot, stdio: 'inherit' },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Capacitor Assets exited with code ${result.status ?? 'unknown'}.`);
  }
};

const main = async () => {
  await Promise.all(Object.values(sourceFiles).map((file) => access(file)));
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(iconStage, { recursive: true });
  await mkdir(splashStage, { recursive: true });

  try {
    // 图标：iOS 不允许透明，--iconBackgroundColor 用于兜底铺底。
    await copyFile(sourceFiles.icon, join(iconStage, 'logo.png'));
    // 启动图：浅色 / 深色两套，Capacitor Assets 靠文件名后缀 splash-dark 识别。
    await Promise.all([
      copyFile(sourceFiles.splashLight, join(splashStage, 'splash.png')),
      copyFile(sourceFiles.splashDark, join(splashStage, 'splash-dark.png')),
    ]);

    runAssets(relative(projectRoot, iconStage), [
      '--iconBackgroundColor', '#efedf8',
      '--iconBackgroundColorDark', '#11142b',
      '--splashBackgroundColor', '#efedf8',
      '--splashBackgroundColorDark', '#11142b',
    ]);
    runAssets(relative(projectRoot, splashStage));
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
};

await main();
