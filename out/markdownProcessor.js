"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarkdownProcessor = void 0;
class MarkdownProcessor {
    protectFormatting(text) {
        const markers = [];
        let result = text;
        // Protect inline code first (highest priority)
        result = result.replace(/`[^`]*`/g, (match) => {
            markers.push(match);
            return `{{MD${markers.length - 1}}}`;
        });
        // Protect bold markers
        result = result.replace(/\*\*/g, () => {
            markers.push('**');
            return `{{MD${markers.length - 1}}}`;
        });
        // Protect italic markers (single *)
        result = result.replace(/\*/g, () => {
            markers.push('*');
            return `{{MD${markers.length - 1}}}`;
        });
        return { text: result, markers };
    }
    restoreFormatting(text, original) {
        // Extract markers from original in same order as protectFormatting
        const markers = [];
        let temp = original;
        // Find inline code first (same order as protection)
        temp = temp.replace(/`[^`]*`/g, (match) => {
            markers.push(match);
            return `{{MD${markers.length - 1}}}`;
        });
        // Find bold markers
        temp = temp.replace(/\*\*/g, () => {
            markers.push('**');
            return `{{MD${markers.length - 1}}}`;
        });
        // Find italic markers
        temp = temp.replace(/\*/g, () => {
            markers.push('*');
            return `{{MD${markers.length - 1}}}`;
        });
        // Restore markers in translated text
        let result = text;
        for (let i = 0; i < markers.length; i++) {
            result = result.replace(new RegExp(`\\{\\{MD${i}\\}\\}`, 'g'), markers[i]);
        }
        return result;
    }
    extractTranslatableText(text) {
        // Extract only the translatable text, removing markdown formatting
        return text
            .replace(/\*\*(.*?)\*\*/g, '$1') // Remove bold
            .replace(/\*(.*?)\*/g, '$1') // Remove italic
            .replace(/\[(.*?)\]\(.*?\)/g, '$1') // Keep only link text
            .replace(/`(.*?)`/g, '$1') // Remove inline code formatting
            .trim();
    }
    extractFormattedParts(text) {
        const parts = [];
        // Extract bold text
        const boldMatches = text.match(/\*\*(.*?)\*\*/g);
        if (boldMatches) {
            for (const match of boldMatches) {
                const content = match.replace(/\*\*/g, '');
                if (content.trim()) {
                    parts.push(content);
                }
            }
        }
        // Extract italic text (not inside bold)
        const italicMatches = text.match(/(?<!\*)\*([^*]+)\*(?!\*)/g);
        if (italicMatches) {
            for (const match of italicMatches) {
                const content = match.replace(/\*/g, '');
                if (content.trim()) {
                    parts.push(content);
                }
            }
        }
        // Extract link text
        const linkMatches = text.match(/\[(.*?)\]/g);
        if (linkMatches) {
            for (const match of linkMatches) {
                const content = match.replace(/[\[\]]/g, '');
                if (content.trim()) {
                    parts.push(content);
                }
            }
        }
        // If no formatted parts found, extract the clean text
        if (parts.length === 0) {
            const cleanText = this.extractTranslatableText(text);
            if (cleanText) {
                parts.push(cleanText);
            }
        }
        return parts;
    }
    reconstructWithTranslation(original, translated) {
        // Handle formatted text by replacing content within formatting markers
        let result = original;
        // Replace bold text
        result = result.replace(/\*\*(.*?)\*\*/g, (match, content) => {
            return `**${translated}**`;
        });
        // Replace italic text (only if no bold was found)
        if (result === original) {
            result = result.replace(/\*([^*]+)\*/g, (match, content) => {
                return `*${translated}*`;
            });
        }
        // Replace link text (only if no bold/italic was found)
        if (result === original) {
            result = result.replace(/\[(.*?)\]\((.*?)\)/g, (match, linkText, url) => {
                return `[${translated}](${url})`;
            });
        }
        // If no formatting was found, return translated text
        if (result === original) {
            return translated;
        }
        return result;
    }
    extractTextNodes(markdown) {
        const nodes = [];
        const lines = markdown.split('\n');
        let index = 0;
        let inCodeBlock = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            // Handle code block boundaries
            if (trimmed.startsWith('```')) {
                inCodeBlock = !inCodeBlock;
                continue;
            }
            // Skip everything inside code blocks
            if (inCodeBlock)
                continue;
            // Skip empty lines
            if (!trimmed)
                continue;
            // Skip indented code blocks
            if (line.startsWith('    ') || line.startsWith('\t'))
                continue;
            // Note: Allow all lines with text to be processed - inline code will be protected by placeholders
            // Skip table separators (lines with only |, -, :, spaces)
            if (trimmed.match(/^\|[\s\-\|:]+\|$/))
                continue;
            // Skip HTML tags
            if (trimmed.startsWith('<') && trimmed.endsWith('>'))
                continue;
            // Extract text from headings
            if (trimmed.startsWith('#')) {
                const text = trimmed.replace(/^#+\s*/, '').trim();
                if (text) {
                    const protectedText = this.protectFormatting(text);
                    nodes.push({
                        value: protectedText.text,
                        original: text,
                        index: index++,
                        type: 'heading'
                    });
                }
                continue;
            }
            // Extract text from lists (remove markdown syntax)
            if (trimmed.match(/^[-*+]\s+/) || trimmed.match(/^\d+\.\s+/)) {
                let text = trimmed.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '');
                if (text) {
                    // Protect formatting markers by replacing with placeholders
                    const protectedText = this.protectFormatting(text);
                    nodes.push({
                        value: protectedText.text,
                        original: text,
                        index: index++,
                        type: 'text'
                    });
                }
                continue;
            }
            // Extract text from blockquotes
            if (trimmed.startsWith('>')) {
                let text = trimmed.replace(/^>\s*/, '').trim();
                if (text) {
                    const protectedText = this.protectFormatting(text);
                    nodes.push({
                        value: protectedText.text,
                        original: text,
                        index: index++,
                        type: 'text'
                    });
                }
                continue;
            }
            // Handle table rows - extract each cell separately
            if (trimmed.startsWith('|') && trimmed.endsWith('|') && !trimmed.match(/^\|[\s\-\|:]+\|$/)) {
                const cells = trimmed.split('|').slice(1, -1);
                for (const cell of cells) {
                    const cellText = cell.trim();
                    if (cellText && !cellText.match(/^[\s\-:]+$/)) {
                        const protectedText = this.protectFormatting(cellText);
                        nodes.push({
                            value: protectedText.text,
                            original: cellText,
                            index: index++,
                            type: 'text'
                        });
                    }
                }
                continue;
            }
            // Extract regular paragraphs
            if (trimmed) {
                const protectedText = this.protectFormatting(trimmed);
                nodes.push({
                    value: protectedText.text,
                    original: trimmed,
                    index: index++,
                    type: 'paragraph'
                });
            }
        }
        return nodes;
    }
    reconstructMarkdown(originalMarkdown, translatedNodes) {
        const lines = originalMarkdown.split('\n');
        const nodeMap = new Map();
        translatedNodes.forEach(node => {
            nodeMap.set(node.index, node.value);
        });
        let nodeIndex = 0;
        const result = [];
        let inCodeBlock = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            // Handle code block boundaries
            if (trimmed.startsWith('```')) {
                inCodeBlock = !inCodeBlock;
                result.push(line);
                continue;
            }
            // Preserve everything inside code blocks
            if (inCodeBlock) {
                result.push(line);
                continue;
            }
            // Preserve empty lines
            if (!trimmed) {
                result.push(line);
                continue;
            }
            // Preserve indented code blocks
            if (line.startsWith('    ') || line.startsWith('\t')) {
                result.push(line);
                continue;
            }
            // Note: Lines with inline code are now processed - formatting is protected/restored
            // Preserve table separators
            if (trimmed.match(/^\|[\s\-\|:]+\|$/)) {
                result.push(line);
                continue;
            }
            // Handle headings
            if (trimmed.startsWith('#')) {
                const match = line.match(/^(\s*#+\s*)/);
                if (match && nodeMap.has(nodeIndex)) {
                    const node = translatedNodes.find(n => n.index === nodeIndex);
                    const original = node?.original || trimmed.replace(/^#+\s*/, '');
                    const translated = nodeMap.get(nodeIndex);
                    const restored = this.restoreFormatting(translated, original);
                    result.push(match[1] + restored);
                    nodeIndex++;
                }
                else {
                    result.push(line);
                }
                continue;
            }
            // Handle lists - simple replacement with formatting restoration
            if (trimmed.match(/^[-*+]\s+/) || trimmed.match(/^\d+\.\s+/)) {
                const match = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)/);
                if (match && nodeMap.has(nodeIndex)) {
                    const node = translatedNodes.find(n => n.index === nodeIndex);
                    const original = node?.original || '';
                    const translated = nodeMap.get(nodeIndex);
                    const restored = this.restoreFormatting(translated, original);
                    result.push(match[1] + restored);
                    nodeIndex++;
                }
                else {
                    result.push(line);
                }
                continue;
            }
            // Handle blockquotes
            if (trimmed.startsWith('>')) {
                const match = line.match(/^(\s*>\s*)/);
                if (match && nodeMap.has(nodeIndex)) {
                    const node = translatedNodes.find(n => n.index === nodeIndex);
                    const original = node?.original || trimmed.replace(/^>\s*/, '');
                    const translated = nodeMap.get(nodeIndex);
                    const restored = this.restoreFormatting(translated, original);
                    result.push(match[1] + restored);
                    nodeIndex++;
                }
                else {
                    result.push(line);
                }
                continue;
            }
            // Handle table rows - reconstruct each cell
            if (trimmed.startsWith('|') && trimmed.endsWith('|') && !trimmed.match(/^\|[\s\-\|:]+\|$/)) {
                const cells = trimmed.split('|');
                let newLine = '|';
                for (let j = 1; j < cells.length - 1; j++) {
                    const cellText = cells[j].trim();
                    if (cellText && !cellText.match(/^[\s\-:]+$/)) {
                        if (nodeMap.has(nodeIndex)) {
                            const node = translatedNodes.find(n => n.index === nodeIndex);
                            const original = node?.original || cellText;
                            const translated = nodeMap.get(nodeIndex);
                            const restored = this.restoreFormatting(translated, original);
                            newLine += ` ${restored} |`;
                            nodeIndex++;
                        }
                        else {
                            newLine += ` ${cellText} |`;
                        }
                    }
                    else {
                        newLine += cells[j] + '|';
                    }
                }
                result.push(newLine);
                continue;
            }
            // Handle regular paragraphs
            if (trimmed) {
                if (nodeMap.has(nodeIndex)) {
                    const node = translatedNodes.find(n => n.index === nodeIndex);
                    const original = node?.original || trimmed;
                    const translated = nodeMap.get(nodeIndex);
                    const restored = this.restoreFormatting(translated, original);
                    result.push(restored);
                    nodeIndex++;
                }
                else {
                    result.push(line);
                }
                continue;
            }
            result.push(line);
        }
        return result.join('\n');
    }
    convertToHtml(markdown) {
        const lines = markdown.split('\n');
        const html = ['<div class="markdown-content">'];
        let inCodeBlock = false;
        let inTable = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('```')) {
                if (inTable) {
                    html.push('</table>');
                    inTable = false;
                }
                if (inCodeBlock) {
                    html.push('</code></pre>');
                }
                else {
                    html.push('<pre><code>');
                }
                inCodeBlock = !inCodeBlock;
                continue;
            }
            if (inCodeBlock) {
                html.push(this.escapeHtml(line));
                continue;
            }
            if (!trimmed) {
                if (inTable) {
                    html.push('</table>');
                    inTable = false;
                }
                // Skip empty lines to avoid extra spacing
                continue;
            }
            // Headings
            if (trimmed.startsWith('#')) {
                if (inTable) {
                    html.push('</table>');
                    inTable = false;
                }
                const level = (trimmed.match(/^#+/) || [''])[0].length;
                const text = trimmed.replace(/^#+\s*/, '');
                html.push(`<h${level}>${this.escapeHtml(text)}</h${level}>`);
                continue;
            }
            // Lists
            if (trimmed.match(/^[-*+]\s+/)) {
                if (inTable) {
                    html.push('</table>');
                    inTable = false;
                }
                const text = trimmed.replace(/^[-*+]\s+/, '');
                html.push(`<li>${this.processInlineMarkdown(text)}</li>`);
                continue;
            }
            // Blockquotes
            if (trimmed.startsWith('>')) {
                if (inTable) {
                    html.push('</table>');
                    inTable = false;
                }
                const text = trimmed.replace(/^>\s*/, '');
                html.push(`<blockquote>${this.processInlineMarkdown(text)}</blockquote>`);
                continue;
            }
            // Tables
            if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
                // Skip separator rows
                if (trimmed.match(/^\|[\s\-\|:]+\|$/)) {
                    continue;
                }
                if (!inTable) {
                    html.push('<table>');
                    inTable = true;
                }
                const cells = trimmed.split('|').slice(1, -1);
                let row = '<tr>';
                // Check if this is likely a header row (next line is separator)
                const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
                const isHeader = nextLine.match(/^\|[\s\-\|:]+\|$/);
                for (const cell of cells) {
                    const cellContent = this.processInlineMarkdown(cell.trim());
                    if (isHeader) {
                        row += `<th>${cellContent}</th>`;
                    }
                    else {
                        row += `<td>${cellContent}</td>`;
                    }
                }
                row += '</tr>';
                html.push(row);
                continue;
            }
            // End table if we're not in a table line anymore
            if (inTable) {
                html.push('</table>');
                inTable = false;
            }
            // Regular paragraphs
            html.push(`<p>${this.processInlineMarkdown(trimmed)}</p>`);
        }
        if (inTable) {
            html.push('</table>');
        }
        html.push('</div>');
        // Join HTML and clean up code block formatting
        let result = html.join('\n');
        // Remove extra newlines around code blocks
        result = result.replace(/<pre><code>\n+/g, '<pre><code>');
        result = result.replace(/\n+<\/code><\/pre>/g, '</code></pre>');
        return result;
    }
    processInlineMarkdown(text) {
        // Process bold, italic, and code
        return text
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code>$1</code>')
            .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');
    }
    escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}
exports.MarkdownProcessor = MarkdownProcessor;
//# sourceMappingURL=markdownProcessor.js.map