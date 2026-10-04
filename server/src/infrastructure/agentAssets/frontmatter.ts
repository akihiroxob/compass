export type FrontmatterValue = string | number | string[];

export type ParsedMarkdown = { data: Record<string, FrontmatterValue>; content: string };

const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, "$2");

const scalar = (value: string): string | number => {
  const text = unquote(value.trim());
  return /^-?\d+$/.test(text) ? Number(text) : text;
};

/**
 * 構成資産のMarkdown frontmatterを読む。対象は`key: value`・`key: [a, b]`・`key:`に続く`  - item`だけで、
 * 依存を増やさないためYAML全体は扱わない。frontmatterが無ければdataは空で、本文はfile全体。
 * 解釈できない行は黙って捨てずに例外にする。
 */
export const parseFrontmatter = (text: string): ParsedMarkdown => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, content: text.trim() };
  const data: Record<string, FrontmatterValue> = {};
  let listKey: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      if (listKey === null) throw new Error(`list item without a key: ${line}`);
      (data[listKey] as string[]).push(unquote(item[1].trim()));
      continue;
    }
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!entry) throw new Error(`unsupported frontmatter line: ${line}`);
    const [, key, value] = entry;
    listKey = null;
    if (value === "") {
      data[key] = [];
      listKey = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      data[key] = inner === "" ? [] : inner.split(",").map((part) => unquote(part.trim()));
    } else {
      data[key] = scalar(value);
    }
  }
  return { data, content: text.slice(match[0].length).trim() };
};
