// @ts-nocheck
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
const vscode = require("vscode");
class Logger {
    static initialize() {
        if (!this.outputChannel) {
            this.outputChannel = vscode.window.createOutputChannel('Markdown 中文翻译器');
        }
    }
    static log(level, message, ...args) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${level}] ${message}`;
        // Log to console for development
        console.log(logMessage, ...args);
        // Log to VS Code output channel
        if (this.outputChannel) {
            this.outputChannel.appendLine(logMessage);
            if (args.length > 0) {
                this.outputChannel.appendLine(`  Args: ${JSON.stringify(args)}`);
            }
        }
    }
    static debug(message, ...args) {
        if (this.isDebug) {
            this.log('DEBUG', message, ...args);
        }
    }
    static info(message, ...args) {
        this.log('INFO', message, ...args);
    }
    static warn(message, ...args) {
        this.log('WARN', message, ...args);
    }
    static error(message, error) {
        this.log('ERROR', message);
        if (error && this.outputChannel) {
            this.outputChannel.appendLine(`  Error: ${error.message}`);
            if (error.stack) {
                this.outputChannel.appendLine(`  Stack: ${error.stack}`);
            }
        }
    }
    static dispose() {
        this.outputChannel?.dispose();
        this.outputChannel = null;
    }
}
exports.Logger = Logger;
Logger.outputChannel = null;
Logger.isDebug = process.env.NODE_ENV === 'development';

