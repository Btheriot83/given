/** A one-time bubble under the speaker on iPhone and iPad: the silent switch mutes the show until the player opts in. */

export function isIOS(nav = navigator) {
  const ua = nav.userAgent || "";
  return /iPhone|iPad|iPod/.test(ua) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
}

export function showSoundHint(anchor, text = "Hear the show? Tap the speaker.") {
  const box = anchor.getBoundingClientRect();
  if (!box.width) return null;
  const hint = document.createElement("div");
  hint.className = "sound-hint";
  hint.setAttribute("role", "status");
  hint.textContent = text;
  document.body.append(hint);
  const width = hint.offsetWidth;
  const center = box.left + box.width / 2;
  const left = Math.min(Math.max(8, center - width / 2), window.innerWidth - width - 8);
  hint.style.left = `${left}px`;
  hint.style.top = `${box.bottom + window.scrollY + 12}px`;
  hint.style.setProperty("--arrow", `${center - left}px`);
  anchor.classList.add("hinting");
  const close = () => {
    hint.remove();
    anchor.classList.remove("hinting");
    window.removeEventListener("pointerdown", close, true);
  };
  setTimeout(() => window.addEventListener("pointerdown", close, true), 0);
  setTimeout(close, 6500);
  return hint;
}
