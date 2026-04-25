import * as vscode from 'vscode';

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'markdownTranslator.testConnection';
    }

    showTranslating(progress?: string): void {
        this.statusBarItem.text = `$(sync~spin) 正在翻译${progress ? ` ${progress}` : '...'}`;
        this.statusBarItem.tooltip = '正在翻译';
        this.statusBarItem.show();
    }

    showReady(): void {
        this.statusBarItem.text = '$(globe) 中文翻译器';
        this.statusBarItem.tooltip = '点击测试翻译连接';
        this.statusBarItem.show();
    }

    showError(message: string): void {
        this.statusBarItem.text = '$(error) 翻译失败';
        this.statusBarItem.tooltip = message;
        this.statusBarItem.show();
    }

    hide(): void {
        this.statusBarItem.hide();
    }

    dispose(): void {
        this.statusBarItem.dispose();
    }
}
