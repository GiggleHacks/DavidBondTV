// Dependency-free emoji picker. attachEmojiPicker(input, button) opens a small
// popover anchored to `button`; clicking an emoji inserts it at the caret in
// `input`. Curated, hardcoded glyph set grouped by category (no external lib,
// matching the rest of this codebase). The Flags tab carries a note that flag
// emoji render as plain letters on Windows.

const GROUPS = [
  ['Smileys', '😀', ['😀','😁','😂','🤣','😊','😍','😎','🤩','😘','😜','🤔','😇','🥳','😅','😉','🙂','🙃','😏','😴','🤤','😬','😱','😭','😡','🥶','🤯','🤠','🤗','🤫','🫡','😈','👻','💀','🤡','👽','🤖','😺','🙈','🙉','🙊']],
  ['People', '👍', ['👍','👎','👏','🙌','👋','🤝','✌️','🤞','🫶','💪','🙏','👀','🧠','👶','🧑','👨','👩','👴','👵','🕺','💃','🏃','🚶','🧘','👮','🕵️','👷','🤵','👸','🦸','🦹','🎅']],
  ['Animals', '🐶', ['🐶','🐱','🦁','🐯','🐴','🦄','🐮','🐷','🐸','🐵','🐔','🐧','🦅','🦉','🦇','🐺','🐗','🐝','🦋','🐢','🐍','🐙','🦈','🐬','🐳','🐟','🐠','🦖','🦕','🐉','🌸','🌻','🌹','🌳','🌵','🍀']],
  ['Food', '🍔', ['🍔','🍟','🍕','🌭','🥪','🌮','🍿','🧀','🍞','🍳','🥗','🍜','🍣','🍦','🍩','🍪','🎂','🍰','🍫','🍬','🍭','🍎','🍌','🍓','🍉','🍇','🥑','🍺','🍷','🍸','🍹','☕','🧃','🥤']],
  ['Activities', '⚽', ['⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🥊','🏆','🥇','🎯','🎮','🎲','🎸','🎹','🎺','🎻','🥁','🎤','🎧','🎬','🎨','🎭','📸','🎥','🏊','🚴','⛷️','🏄','🧗']],
  ['Travel', '✈️', ['✈️','🚗','🚕','🚙','🚌','🏎️','🏍️','🚲','🛵','🚂','🚀','🛸','⛵','🛥️','🚁','🗺️','🗽','🗼','🏰','🏝️','🏖️','⛰️','🌋','🏕️','🌅','🌄','🌃','🌉','🎡','🎢','🏨','⛺','🧳']],
  ['Objects', '💡', ['💡','🔥','⭐','🌟','✨','💥','💫','❤️','🧡','💛','💚','💙','💜','🖤','🤍','💯','✅','❌','⚡','💎','🔑','🔒','📌','📎','📷','📱','💻','⌚','🎁','🎉','🎊','🏷️','📺','🔔','💰','📈']],
  ['Symbols', '⬆️', ['⬆️','⬇️','⬅️','➡️','▶️','⏸️','⏹️','🔁','🔄','➕','➖','✔️','☑️','❓','❗','‼️','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','♻️','🆕','🆒','🆗','🔝','#️⃣','™️','©️','®️']],
  ['Flags', '🏁', ['🏁','🚩','🏳️','🏴','🏳️‍🌈','🇺🇸','🇬🇧','🇨🇦','🇦🇺','🇩🇪','🇫🇷','🇪🇸','🇮🇹','🇯🇵','🇰🇷','🇨🇳','🇧🇷','🇲🇽','🇮🇳','🇷🇺','🇳🇱','🇸🇪','🇳🇴','🇮🇪','🇵🇹','🇬🇷','🇹🇷','🇿🇦','🇦🇪','🇸🇬','🇹🇭','🇵🇭','🇮🇩']],
];

let openPopover = null;
function closeOpen() {
  if (openPopover) { openPopover.remove(); openPopover = null; document.removeEventListener('click', onDocClick, true); }
}
function onDocClick(e) {
  if (openPopover && !openPopover.contains(e.target) && !openPopover._anchor.contains(e.target)) closeOpen();
}

function insertAtCaret(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const caret = start + text.length;
  input.setSelectionRange(caret, caret);
  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function buildPopover(input, anchor) {
  const pop = document.createElement('div');
  pop.className = 'emoji-pop';
  pop._anchor = anchor;

  const tabs = document.createElement('div');
  tabs.className = 'emoji-tabs';
  const grid = document.createElement('div');
  grid.className = 'emoji-grid';
  const note = document.createElement('div');
  note.className = 'emoji-note';

  function showGroup(idx) {
    const [name, , glyphs] = GROUPS[idx];
    grid.innerHTML = '';
    for (const g of glyphs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'emoji-cell';
      b.textContent = g;
      b.addEventListener('click', () => insertAtCaret(input, g));
      grid.appendChild(b);
    }
    note.textContent = name === 'Flags'
      ? 'Note: flag emoji show as letters (e.g. "US") on Windows.'
      : '';
    tabs.querySelectorAll('button').forEach((t, i) => t.classList.toggle('on', i === idx));
  }

  GROUPS.forEach(([, icon], i) => {
    const t = document.createElement('button');
    t.type = 'button';
    t.textContent = icon;
    t.title = GROUPS[i][0];
    t.addEventListener('click', () => showGroup(i));
    tabs.appendChild(t);
  });

  pop.append(tabs, grid, note);
  showGroup(0);
  return pop;
}

export function attachEmojiPicker(input, button) {
  if (!input || !button) return;
  button.addEventListener('click', (e) => {
    e.preventDefault();
    if (openPopover && openPopover._anchor === button) { closeOpen(); return; }
    closeOpen();
    const pop = buildPopover(input, button);
    // Anchor below the button within its positioned parent.
    const host = button.offsetParent || button.parentElement || document.body;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(pop);
    pop.style.top = `${button.offsetTop + button.offsetHeight + 6}px`;
    pop.style.left = `${button.offsetLeft}px`;
    openPopover = pop;
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
  });
}
