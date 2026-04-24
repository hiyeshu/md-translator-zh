# Change Log

## [1.4.5] - 2025-12-16

### 📦 Package Size Optimization
- **Removed unused screenshots**: Excluded 1+ MB of unused PNG files from VSIX
- **Kept only essential assets**: Extension icon only
- **Reduced package size**: From 1.2 MB to ~200 KB
- **No functionality impact**: Screenshots weren't referenced in README or documentation

## [1.4.4] - 2025-12-16

### 🎯 Minimal Web-Compatible Implementation
- **Removed excessive logging**: Kept only essential error handling
- **Simplified webview creation**: Applied only critical web compatibility patterns
- **Clean file operations**: Web-compatible VS Code APIs without bloat
- **Essential service worker blocking**: Minimal but effective approach
- **Focused on core functionality**: Translation works, webview opens, no extras

## [1.4.3] - 2025-12-16

### 🌐 Proper WebView Panel Configuration for Web Compatibility
- **Enhanced webview options**: Added `retainContextWhenHidden: true` for web environment stability
- **Proper ViewColumn handling**: Fixed panel creation with explicit viewColumn object
- **Async method calls**: Made all file operations properly async throughout the chain
- **Web-compatible panel options**: Added proper CSP and resource handling for Antigravity IDE
- **Following GitLens patterns**: Implemented proven webview patterns from successful web extensions

## [1.4.2] - 2025-12-16

### 🔧 Web Extension Compatibility Fixes + Enhanced Logging
- **Fixed fs API usage**: Replaced fs.existsSync/readFileSync with VS Code workspace API for web compatibility
- **Comprehensive step-by-step logging**: Added detailed logs for every operation in extension activation and webview creation
- **Error tracking**: Enhanced error handling with specific failure points
- **Async file operations**: Proper async/await for all file operations
- **Web environment support**: Full compatibility with Google Antigravity IDE and web VS Code

## [1.4.1] - 2025-12-16

### 🔍 Comprehensive Debug Logging Added
- **Detailed environment detection**: Logs location, user agent, protocol, origin
- **VS Code API detection**: Logs availability and type of acquireVsCodeApi
- **Service Worker state tracking**: Logs original and replaced SW object states
- **Registration attempt logging**: Logs all blocked SW registration attempts
- **Error tracking**: Logs any failures in SW blocking process
- **Multi-view logging**: Debug info in all WebView templates (main, loading, error, no-content)

## [1.4.0] - 2025-12-16

### 🔥 Complete Service Worker Elimination (Qwen's Defensive Approach)
- **Immediate SW blocking**: Replaces navigator.serviceWorker object at HTML load
- **Defensive override**: Blocks ALL registration attempts, not just conditional
- **Non-configurable replacement**: Prevents any third-party code from re-enabling
- **Complete API stubbing**: Provides safe stubs for all SW methods
- **Zero tolerance approach**: Eliminates InvalidStateError completely

## [1.3.9] - 2025-12-16

### 🧹 Production Release Cleanup
- **Clean project structure**: Organized files for production distribution
- **VSIX optimization**: Removed development artifacts from package
- **Documentation review**: Ensured content integrity and consistency
- **Build process**: Streamlined packaging to dist/ folder

## [1.3.8] - 2025-12-16

### 🌐 Enhanced Web Extension Compatibility
- **VS Code WebView detection**: Uses `acquireVsCodeApi` to properly detect VS Code environment
- **Conditional service worker blocking**: Only blocks in VS Code WebView, allows external usage
- **Web Extension support**: Added `browser` field to package.json for full Web VS Code compatibility
- **Follows VS Code best practices**: Implements official recommendations for Web Extension development

## [1.3.7] - 2025-12-16

### 🛡️ Enhanced Service Worker Blocking for Antigravity IDE
- **JavaScript-level service worker override**: Added immediate script to block navigator.serviceWorker API
- **Enhanced CSP headers**: Added `child-src 'none'` for additional webview protection
- **Dual-layer protection**: CSP + JavaScript override prevents InvalidStateError in all webview contexts
- **Antigravity IDE compatibility**: Eliminates service worker registration errors completely

## [1.3.6] - 2025-12-16

### 🛡️ CSP Worker-src Fix for Open VSX Compatibility
- **Added `worker-src 'none'` to ALL HTML templates**: Explicitly blocks any service worker registration attempts by the webview environment
- **Complete CSP Coverage**: All webview HTML (main, loading, error, no-content) now have consistent CSP headers
- **Open VSX / Antigravity Compatibility**: Prevents the IDE's webview infrastructure from attempting service worker registration

### 🔧 Technical Details
The error "InvalidStateError: Failed to register a ServiceWorker" was caused by the IDE's webview environment attempting to register service workers, not by mdcarrot's code. This fix explicitly tells the browser to block any such attempts via CSP.

**CSP Header:**
```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; worker-src 'none';
```

### ✅ Compatibility
- VS Code ✅
- Open VSX ✅
- Google Antigravity ✅
- VSCodium ✅

## [1.3.0] - 2025-12-15

### ✨ Major Features
- Enhanced Explorer Integration
- Auto-Translation on split pane open
- Smart File Tracking for keyboard shortcuts
- Tab Title: "繁 mdcarrot: filename.md"

## [1.2.1] - 2025-12-15

### Initial Release
- Professional markdown translation tool
- Multi-provider support (Google, Azure, Amazon)
- Smart delta translation
- Split-pane interface
- Format preservation
- Intelligent caching
