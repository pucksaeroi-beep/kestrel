'use strict';
// Incremental Server-Sent-Events parser: feed() text chunks, get back complete `data:` payloads.
function sseParser() {
  let buf = '';
  return {
    feed(chunk) {
      buf += chunk;
      const out = [];
      let i;
      // events are separated by a blank line (\n\n or \r\n\r\n)
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (data) out.push(data);
      }
      return out;
    },
  };
}

/** Pull the text out of one streamed JSON chunk for each wire format. */
function deltaText(kind, json) {
  if (kind === 'openai') return json?.choices?.[0]?.delta?.content || '';
  if (kind === 'gemini') return (json?.candidates?.[0]?.content?.parts || []).map((p) => (p.thought ? '' : p.text || '')).join('');
  return '';
}

module.exports = { sseParser, deltaText };
