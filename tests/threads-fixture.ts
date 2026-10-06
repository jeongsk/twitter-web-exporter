import type { ThreadsPost } from '../src/threads/model';
export const threadsSample: ThreadsPost = {
  code: 'Case_A1',
  url: 'https://www.threads.com/@writer.one/post/Case_A1',
  author: 'writer.one',
  text: '좋아요',
  published: '',
  links: [],
  media: [],
  truncated: false,
};
export function card(
  code: string,
  text: string,
  options: {
    author?: string;
    image?: string;
    parent?: string;
    more?: boolean;
    semantic?: boolean;
    quote?: string;
    date?: string;
  } = {},
) {
  const author = options.author ?? 'writer.one';
  const open = options.semantic === false ? '<div class="test-card" role="button">' : '<article>';
  const close = options.semantic === false ? '</div>' : '</article>';
  return `${open}<header><a href="/@${author}"><img width="32" height="32" src="https://cdn.example/avatar-${author}.png" alt="${author}'s profile picture"><span dir="auto">${author}</span></a>
    <span dir="auto"><a href="/@${author}/post/${code}?tracking=discard"><span>원문</span></a></span>
    ${options.date ? `<time datetime="${options.date}">어제</time>` : ''}</header>
    ${options.parent ? `<div role="note">Replying to <a aria-label="Replying to writer.one" href="/@writer.one/post/${options.parent}">@writer.one</a></div>` : ''}
    <div class="body-group"><div>${text ? `<span dir="auto">${text}</span>` : ''}</div></div>
    ${options.more ? '<button>더 보기</button>' : ''}
    ${options.image ? `<div class="media-sibling"><img width="320" height="180" src="https://cdn.example/${options.image}.jpg" alt="${options.image}"></div>` : ''}
    ${options.quote ? `<blockquote>${card(options.quote, '인용 안의 다른 게시물')}</blockquote>` : ''}
    <div role="toolbar"><button><span dir="auto">123</span></button></div>${close}`;
}
export function threadsHtml(content: string) {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>Threads synthetic fixture</title>
  <body><nav><a href="/@noise/post/Navigation">추천</a></nav><main>${content}</main>
  <aside>${card('Sidebar', '백업되면 안 되는 추천')}</aside></body></html>`;
}
