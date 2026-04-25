export interface TextNode {
    value: string;
    original: string;
    index: number;
    type: 'heading' | 'text' | 'paragraph';
}

export interface ProtectedText {
    text: string;
    markers: string[];
}

export class MarkdownProcessor {
    protectFormatting(text: string): ProtectedText {
        const markers: string[] = [];
        let result = text;
        result = result.replace(/`[^`]*`/g, (match) => {
            markers.push(match);
            return `{{MD${markers.length - 1}}}`;
        });
        result = result.replace(/\*\*/g, () => {
            markers.push('**');
            return `{{MD${markers.length - 1}}}`;
        });
        result = result.replace(/\*/g, () => {
            markers.push('*');
            return `{{MD${markers.length - 1}}}`;
        });
        return { text: result, markers };
    }

    restoreFormatting(text: string, original: string): string {
        const markers: string[] = [];
        let temp = original;
        temp = temp.replace(/`[^`]*`/g, (match) => {
            markers.push(match);
            return `{{MD${markers.length - 1}}}`;
        });
        temp = temp.replace(/\*\*/g, () => {
            markers.push('**');
            return `{{MD${markers.length - 1}}}`;
        });
        temp = temp.replace(/\*/g, () => {
            markers.push('*');
            return `{{MD${markers.length - 1}}}`;
        });
        let result = text;
        for (let i = 0; i < markers.length; i++) {
            result = result.replace(new RegExp(`\\{\\{MD${i}\\}\\}`, 'g'), markers[i]);
        }
        return result;
    }
    extractTranslatableText(text: string): string {
        return text
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .replace(/\[(.*?)\]\(.*?\)/g, '$1')
            .replace(/`(.*?)`/g, '$1')
            .trim();
    }

    extractFormattedParts(text: string): string[] {
        const parts: string[] = [];
        const boldMatches = text.match(/\*\*(.*?)\*\*/g);
        if (boldMatches) {
            for (const match of boldMatches) {
                const content = match.replace(/\*\*/g, '');
                if (content.trim()) { parts.push(content); }
            }
        }
        const italicMatches = text.match(/(?<!\*)\*([^*]+)\*(?!\*)/g);
        if (italicMatches) {
            for (const match of italicMatches) {
                const content = match.replace(/\*/g, '');
                if (content.trim()) { parts.push(content); }
            }
        }
        const linkMatches = text.match(/\[(.*?)\]/g);
        if (linkMatches) {
            for (const match of linkMatches) {
                const content = match.replace(/[\[\]]/g, '');
                if (content.trim()) { parts.push(content); }
            }
        }
        if (parts.length === 0) {
            const cleanText = this.extractTranslatableText(text);
            if (cleanText) { parts.push(cleanText); }
        }
        return parts;
    }

    reconstructWithTranslation(original: string, translated: string): string {
        let result = original;
        result = result.replace(/\*\*(.*?)\*\*/g, () => `**${translated}**`);
        if (result === original) {
            result = result.replace(/\*([^*]+)\*/g, () => `*${translated}*`);
        }
        if (result === original) {
            result = result.replace(/\[(.*?)\]\((.*?)\)/g, (_match, _linkText, url: string) => `[${translated}](${url})`);
        }
        if (result === original) { return translated; }
        return result;
    }
    extractTextNodes(markdown: string): TextNode[] {
        const nodes: TextNode[] = [];
        const lines = markdown.split('\n');
        let index = 0;
        let inCodeBlock = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
            if (inCodeBlock) continue;
            if (!trimmed) continue;
            if (line.startsWith('    ') || line.startsWith('\t')) continue;
            if (trimmed.match(/^\|[\s\-|:]+\|$/)) continue;
            if (trimmed.startsWith('<') && trimmed.endsWith('>')) continue;
            if (trimmed.startsWith('#')) {
                const text = trimmed.replace(/^#+\s*/, '').trim();
                if (text) {
                    const protectedText = this.protectFormatting(text);
                    nodes.push({ value: protectedText.text, original: text, index: index++, type: 'heading' });
                }
                continue;
            }
            if (trimmed.match(/^[-*+]\s+/) || trimmed.match(/^\d+\.\s+/)) {
                const text = trimmed.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '');
                if (text) {
                    const protectedText = this.protectFormatting(text);
                    nodes.push({ value: protectedText.text, original: text, index: index++, type: 'text' });
                }
                continue;
            }
            if (trimmed.startsWith('>')) {
                const text = trimmed.replace(/^>\s*/, '').trim();
                if (text) {
                    const protectedText = this.protectFormatting(text);
                    nodes.push({ value: protectedText.text, original: text, index: index++, type: 'text' });
                }
                continue;
            }
            if (trimmed.startsWith('|') && trimmed.endsWith('|') && !trimmed.match(/^\|[\s\-|:]+\|$/)) {
                const cells = trimmed.split('|').slice(1, -1);
                for (const cell of cells) {
                    const cellText = cell.trim();
                    if (cellText && !cellText.match(/^[\s\-:]+$/)) {
                        const protectedText = this.protectFormatting(cellText);
                        nodes.push({ value: protectedText.text, original: cellText, index: index++, type: 'text' });
                    }
                }
                continue;
            }
            if (trimmed) {
                const protectedText = this.protectFormatting(trimmed);
                nodes.push({ value: protectedText.text, original: trimmed, index: index++, type: 'paragraph' });
            }
        }
        return nodes;
    }
    reconstructMarkdown(originalMarkdown: string, translatedNodes: TextNode[]): string {
        const lines = originalMarkdown.split('\n');
        const nodeMap = new Map<number, string>();
        translatedNodes.forEach(node => { nodeMap.set(node.index, node.value); });
        let nodeIndex = 0;
        const result: string[] = [];
        let inCodeBlock = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('```')) { inCodeBlock = !inCodeBlock; result.push(line); continue; }
            if (inCodeBlock) { result.push(line); continue; }
            if (!trimmed) { result.push(line); continue; }
            if (line.startsWith('    ') || line.startsWith('\t')) { result.push(line); continue; }
            if (trimmed.match(/^\|[\s\-|:]+\|$/)) { result.push(line); continue; }
            if (trimmed.startsWith('#')) {
                const match = line.match(/^(\s*#+\s*)/);
                if (match && nodeMap.has(nodeIndex)) {
                    const node = translatedNodes.find(n => n.index === nodeIndex);
                    const original = node?.original || trimmed.replace(/^#+\s*/, '');
                    const translated = nodeMap.get(nodeIndex)!;
                    result.push(match[1] + this.restoreFormatting(translated, original));
                    nodeIndex++;
                } else { result.push(line); }
                continue;
            }
            if (trimmed.match(/^[-*+]\s+/) || trimmed.match(/^\d+\.\s+/)) {
                const match = line.match(/^(\s*(?:[-*+]|\d+\.)\s+)/);
                if (match && nodeMap.has(nodeIndex)) {
                    const node = translatedNodes.find(n => n.index === nodeIndex);
                    const translated = nodeMap.get(nodeIndex)!;
                    result.push(match[1] + this.restoreFormatting(translated, node?.original || ''));
                    nodeIndex++;
                } else { result.push(line); }
                continue;
            }
            if (trimmed.startsWith('>')) {
                const match = line.match(/^(\s*>\s*)/);
                if (match && nodeMap.has(nodeIndex)) {
                    const node = translatedNodes.find(n => n.index === nodeIndex);
                    const original = node?.original || trimmed.replace(/^>\s*/, '');
                    const translated = nodeMap.get(nodeIndex)!;
                    result.push(match[1] + this.restoreFormatting(translated, original));
                    nodeIndex++;
                } else { result.push(line); }
                continue;
            }
            if (trimmed.startsWith('|') && trimmed.endsWith('|') && !trimmed.match(/^\|[\s\-|:]+\|$/)) {
                const cells = trimmed.split('|');
                let newLine = '|';
                for (let j = 1; j < cells.length - 1; j++) {
                    const cellText = cells[j].trim();
                    if (cellText && !cellText.match(/^[\s\-:]+$/)) {
                        if (nodeMap.has(nodeIndex)) {
                            const node = translatedNodes.find(n => n.index === nodeIndex);
                            const translated = nodeMap.get(nodeIndex)!;
                            newLine += ` ${this.restoreFormatting(translated, node?.original || cellText)} |`;
                            nodeIndex++;
                        } else { newLine += ` ${cellText} |`; }
                    } else { newLine += cells[j] + '|'; }
                }
                result.push(newLine);
                continue;
            }
            if (trimmed) {
                if (nodeMap.has(nodeIndex)) {
                    const node = translatedNodes.find(n => n.index === nodeIndex);
                    const translated = nodeMap.get(nodeIndex)!;
                    result.push(this.restoreFormatting(translated, node?.original || trimmed));
                    nodeIndex++;
                } else { result.push(line); }
                continue;
            }
            result.push(line);
        }
        return result.join('\n');
    }
    convertToHtml(markdown: string): string {
        const lines = markdown.split('\n');
        const html: string[] = ['<div class="markdown-content">'];
        let inCodeBlock = false;
        let inTable = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            if (trimmed.startsWith('```')) {
                if (inTable) { html.push('</table>'); inTable = false; }
                html.push(inCodeBlock ? '</code></pre>' : '<pre><code>');
                inCodeBlock = !inCodeBlock;
                continue;
            }
            if (inCodeBlock) { html.push(this.escapeHtml(line)); continue; }
            if (!trimmed) { if (inTable) { html.push('</table>'); inTable = false; } continue; }
            if (trimmed.startsWith('#')) {
                if (inTable) { html.push('</table>'); inTable = false; }
                const level = (trimmed.match(/^#+/) || [''])[0].length;
                const text = trimmed.replace(/^#+\s*/, '');
                html.push(`<h${level}>${this.escapeHtml(text)}</h${level}>`);
                continue;
            }
            if (trimmed.match(/^[-*+]\s+/)) {
                if (inTable) { html.push('</table>'); inTable = false; }
                html.push(`<li>${this.processInlineMarkdown(trimmed.replace(/^[-*+]\s+/, ''))}</li>`);
                continue;
            }
            if (trimmed.startsWith('>')) {
                if (inTable) { html.push('</table>'); inTable = false; }
                html.push(`<blockquote>${this.processInlineMarkdown(trimmed.replace(/^>\s*/, ''))}</blockquote>`);
                continue;
            }
            if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
                if (trimmed.match(/^\|[\s\-|:]+\|$/)) continue;
                if (!inTable) { html.push('<table>'); inTable = true; }
                const cells = trimmed.split('|').slice(1, -1);
                const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
                const isHeader = nextLine.match(/^\|[\s\-|:]+\|$/);
                let row = '<tr>';
                for (const cell of cells) {
                    const c = this.processInlineMarkdown(cell.trim());
                    row += isHeader ? `<th>${c}</th>` : `<td>${c}</td>`;
                }
                html.push(row + '</tr>');
                continue;
            }
            if (inTable) { html.push('</table>'); inTable = false; }
            html.push(`<p>${this.processInlineMarkdown(trimmed)}</p>`);
        }
        if (inTable) html.push('</table>');
        html.push('</div>');
        let result = html.join('\n');
        result = result.replace(/<pre><code>\n+/g, '<pre><code>');
        result = result.replace(/\n+<\/code><\/pre>/g, '</code></pre>');
        return result;
    }

    processInlineMarkdown(text: string): string {
        return text
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code>$1</code>')
            .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');
    }

    escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
}
