const escapeHtml = (text: string): string => {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

const escapeHtmlAttr = (text: string): string => {
  return escapeHtml(text).replace(/"/g, '&quot;');
};

export const renderTelegramHtmlFromMarkdown = (markdown: string): string => {
  let text = markdown.replace(/\r\n/g, '\n');
  const placeholders: string[] = [];

  const stash = (html: string): string => {
    const token = `__TG_HTML_PLACEHOLDER_${placeholders.length}__`;
    placeholders.push(html);
    return token;
  };

  text = text.replace(/```(?:[^\n`]*)\n([\s\S]*?)```/g, (_, code: string) => {
    const rendered = `<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`;
    return stash(rendered);
  });

  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    return stash(`<code>${escapeHtml(code)}</code>`);
  });

  text = escapeHtml(text);

  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
    return `<a href="${escapeHtmlAttr(href)}">${label}</a>`;
  });

  text = text.replace(/\*\*([^\n*][\s\S]*?[^\n*])\*\*/g, '<b>$1</b>');
  text = text.replace(/~~([^\n~][\s\S]*?[^\n~])~~/g, '<s>$1</s>');
  text = text.replace(/(^|[^*])\*([^\n*]+)\*(?!\*)/g, '$1<i>$2</i>');

  text = text.replace(/__TG_HTML_PLACEHOLDER_(\d+)__/g, (_, indexText: string) => {
    const index = Number.parseInt(indexText, 10);
    return Number.isFinite(index) && placeholders[index] ? placeholders[index] : '';
  });

  return text;
};
