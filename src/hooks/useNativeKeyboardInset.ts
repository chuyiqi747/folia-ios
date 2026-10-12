import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';

// 当前文件：iOS 键盘避让与安全区联动。
//
// 这是 iOS 与 Android 差异最大的交互细节之一：
//
//   Android  系统会 resize 整个 WebView，CSS 里用 100vh 就够了；
//   iOS      WKWebView 默认不 resize，键盘直接盖在页面上。
//            必须监听 keyboardWillShow / keyboardWillHide，拿到键盘高度，
//            写进一个 CSS 变量 --keyboard-height，让搜索框、歌单重命名输入框
//            自己往上抬。同时要为「键盘 + 底部安全区」叠加留白，
//            否则在带 Home Indicator 的机型上输入框会被栏住。

const KEYBOARD_VAR = '--keyboard-height';

export const useNativeKeyboardInset = (): void => {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const root = document.documentElement;
    root.style.setProperty(KEYBOARD_VAR, '0px');

    const shownSub = Keyboard.addListener('keyboardWillShow', (info) => {
      root.style.setProperty(KEYBOARD_VAR, `${info.keyboardHeight}px`);
      root.dataset.keyboardOpen = 'true';
    });

    const hiddenSub = Keyboard.addListener('keyboardWillHide', () => {
      root.style.setProperty(KEYBOARD_VAR, '0px');
      delete root.dataset.keyboardOpen;
    });

    void Keyboard.setResizeMode({ mode: KeyboardResize.None }).catch(() => {
      // 桌面端与部分 Android ROM 不支持该模式，忽略即可。
    });

    return () => {
      void Promise.all([shownSub.then((s) => s.remove()), hiddenSub.then((s) => s.remove())]);
      root.style.removeProperty(KEYBOARD_VAR);
      delete root.dataset.keyboardOpen;
    };
  }, []);
};

export default useNativeKeyboardInset;
