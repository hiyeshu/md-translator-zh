import * as vscode from 'vscode';

export class Logger {
    private static outputChannel: vscode.OutputChannel | null = null;
    private static isDebug = process.env.NODE_ENV === 'development';

    static initialize(): void {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('Markdown 中文翻译器');
        }
    }

    static log(level: string, message: string, ...args: unknown[]): void {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level}] ${message}`;
        console.log(logMessage, ...args);
        if (this.outputChannel) {
            this.outputChannel.appendLine(logMessage);
            if (args.length > 0) {
                this.outputChannel.appendLine(`  Args: ${JSON.stringify(args)}`);
            }
        }
    }

    static debug(message: string, ...args: unknown[]): void {
        if (this.isDebug) this.log('DEBUG', message, ...args);
    }

    static info(message: string, ...args: unknown[]): void {
        this.log('INFO', message, ...args);
    }

    static warn(message: string, ...args: unknown[]): void {
        this.log('WARN', message, ...args);
    }

    static error(message: string, error?: Error): void {
        this.log('ERROR', message);
        if (error && this.outputChannel) {
            this.outputChannel.appendLine(`  Error: ${error.message}`);
            if (error.stack) {
                this.outputChannel.appendLine(`  Stack: ${error.stack}`);
            }
        }
    }

    static dispose(): void {
        this.outputChannel?.dispose();
        this.outputChannel = null;
    }
}
