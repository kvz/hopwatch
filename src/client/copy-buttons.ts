const COPIED_LABEL_MS = 1_800

function fallbackCopy(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-1000px'
  textarea.style.left = '-1000px'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    return document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText != null) {
    await navigator.clipboard.writeText(text)
    return
  }

  if (!fallbackCopy(text)) {
    throw new Error('Clipboard copy failed')
  }
}

function setButtonLabel(button: HTMLButtonElement, label: string): void {
  const textNode = button.querySelector('span:last-child')
  if (textNode != null) textNode.textContent = label
}

export function enhanceCopyButton(button: HTMLButtonElement): void {
  const copyText = button.getAttribute('data-copy-text')
  if (copyText == null || copyText.trim() === '') return
  const originalLabel =
    button.querySelector<HTMLSpanElement>('span:last-child')?.textContent?.trim() ??
    'Copy escalation'

  button.addEventListener('click', () => {
    void writeClipboard(copyText)
      .then(() => {
        setButtonLabel(button, 'Copied')
        setTimeout(() => setButtonLabel(button, originalLabel), COPIED_LABEL_MS)
      })
      .catch(() => {
        setButtonLabel(button, 'Copy failed')
        setTimeout(() => setButtonLabel(button, originalLabel), COPIED_LABEL_MS)
      })
  })
}

export function enhanceCopyButtons(root: ParentNode = document): void {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-copy-text]'))
  for (const button of buttons) enhanceCopyButton(button)
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => enhanceCopyButtons())
  } else {
    enhanceCopyButtons()
  }
}
