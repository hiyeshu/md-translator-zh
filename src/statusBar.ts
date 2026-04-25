// @ts-nocheck
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatusBarManager = void 0;
const vscode = require("vscode");
class StatusBarManager {
    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'mdcarrot.testConnection';
    }
    showTranslating(progress) {
        this.statusBarItem.text = `$(sync~spin) 正在翻译${progress ? ` ${progress}` : '...'}`;
        this.statusBarItem.tooltip = '正在翻译';
        this.statusBarItem.show();
    }
    showReady() {
        this.statusBarItem.text = '$(globe) 中文翻译器';
        this.statusBarItem.tooltip = '点击测试翻译连接';
        this.statusBarItem.show();
    }
    showError(message) {
        this.statusBarItem.text = '$(error) 翻译失败';
        this.statusBarItem.tooltip = message;
        this.statusBarItem.show();
    }
    hide() {
        this.statusBarItem.hide();
    }
    dispose() {
        this.statusBarItem.dispose();
    }
}
exports.StatusBarManager = StatusBarManager;

