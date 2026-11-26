import { normalize } from './core.js';

export function matchingSuggestions(options, value) {
  const query = normalize(value.trim());
  if (!query) return [];
  const matches = new Map();
  for (const option of options) {
    const key = normalize(option);
    if (key.includes(query) && key !== query && !matches.has(key)) matches.set(key,option);
  }
  return [...matches.entries()]
    .sort(([a,left],[b,right]) => Number(b.startsWith(query)) - Number(a.startsWith(query))
      || left.localeCompare(right,'es'))
    .slice(0,8).map(([,option]) => option);
}

export function attachSuggestions(input, list, options) {
  input.setAttribute('role','combobox');
  input.setAttribute('aria-autocomplete','list');
  input.setAttribute('aria-controls',list.id);
  input.autocomplete = 'off';
  list.setAttribute('role','listbox');
  let active = -1;

  function close() {
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded','false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function choose(value) {
    input.value = value;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    close();
  }

  function render() {
    close();
    if (input.disabled) return;
    const matches = matchingSuggestions(options(),input.value);
    for (const [index,value] of matches.entries()) {
      const option = document.createElement('div');
      option.id = `${list.id}-${index}`;
      option.setAttribute('role','option');
      option.setAttribute('aria-selected','false');
      option.textContent = value;
      option.addEventListener('mousedown',event => event.preventDefault());
      option.addEventListener('click',() => choose(value));
      list.append(option);
    }
    if (matches.length) {
      list.hidden = false;
      input.setAttribute('aria-expanded','true');
    }
  }

  input.addEventListener('input',event => { if (!event.isComposing) render(); });
  input.addEventListener('compositionend',render);
  input.addEventListener('focus',render);
  input.addEventListener('blur',close);
  input.addEventListener('keydown',event => {
    if (event.isComposing) return;
    if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter' && !list.hidden) {
      event.preventDefault();
      if (active >= 0) choose(list.children[active].textContent);
      else close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (list.hidden) render();
      if (list.hidden) return;
      event.preventDefault();
      const last = list.children.length - 1;
      active = event.key === 'ArrowDown' ? (active + 1) % (last + 1) : active <= 0 ? last : active - 1;
      for (const [index,option] of Array.from(list.children).entries()) {
        option.setAttribute('aria-selected',String(index === active));
      }
      const option = list.children[active];
      input.setAttribute('aria-activedescendant',option.id);
      option.scrollIntoView({block:'nearest'});
    }
  });
  close();
  return close;
}
