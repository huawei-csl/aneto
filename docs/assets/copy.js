// Copy buttons. A button with data-target copies that element; every other <pre> gets its own
// button, except command output (<pre class="output">).

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Plain http (a LAN preview) has no Clipboard API
  const t = document.createElement("textarea");
  t.value = text;
  t.setAttribute("readonly", "");
  t.style.position = "fixed";
  t.style.opacity = "0";
  document.body.append(t);
  t.select();
  const ok = document.execCommand("copy");
  t.remove();
  if (!ok) throw new Error("copy refused");
}

function bind(button, source) {
  button.addEventListener("click", async () => {
    try {
      await copyText(source().textContent);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select and copy";
    }
    setTimeout(() => { button.textContent = "Copy"; }, 1600);
  });
}

export function addCopyButtons(root = document) {
  // A code block that scrolls sideways must take the keyboard focus
  root.querySelectorAll("pre:not([tabindex])").forEach(pre => { pre.tabIndex = 0; });
  root.querySelectorAll("button.copy[data-target]:not([data-bound])").forEach(b => {
    b.dataset.bound = "";
    bind(b, () => document.getElementById(b.dataset.target));
  });
  root.querySelectorAll("pre:not(.output):not([id])").forEach(pre => {
    if (pre.parentElement.classList.contains("codeblock")) return;
    const box = document.createElement("div"), b = document.createElement("button");
    box.className = "codeblock";
    b.className = "small copy";
    b.type = "button";
    b.textContent = "Copy";
    b.setAttribute("aria-label", "Copy to the clipboard");
    pre.replaceWith(box);
    box.append(b, pre);
    bind(b, () => pre);
  });
}

addCopyButtons();
