// Sign-in window: makes the page look like Firefox, consistently with the Firefox user agent.
// Google flags embedded browsers when Chromium-only APIs contradict the user agent.
const { contextBridge, webFrame } = require('electron');

const spoof = function () {
  try {
    const nav = Navigator.prototype;
    Object.defineProperty(nav, 'userAgentData', { get: () => undefined, configurable: true });
    Object.defineProperty(nav, 'vendor', { get: () => '', configurable: true });
    Object.defineProperty(nav, 'webdriver', { get: () => false, configurable: true });
    Object.defineProperty(nav, 'oscpu', { get: () => 'Windows NT 10.0; Win64; x64', configurable: true });
    Object.defineProperty(nav, 'buildID', { get: () => '20181001000000', configurable: true });
    Object.defineProperty(nav, 'productSub', { get: () => '20100101', configurable: true });
    delete window.chrome;
    Object.defineProperty(window, 'chrome', { get: () => undefined, configurable: true });
  } catch {}
};

try {
  if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: spoof });
  else webFrame.executeJavaScript('(' + spoof.toString() + ')()');
} catch {
  try { webFrame.executeJavaScript('(' + spoof.toString() + ')()'); } catch {}
}
