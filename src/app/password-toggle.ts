import { Component, input, linkedSignal } from '@angular/core';

@Component({
  selector: 'button[appPasswordToggle]',
  template: `{{ visible() ? 'Hide' : 'Show' }}`,
  host: {
    type: 'button',
    '[attr.aria-label]': "(visible() ? 'Hide ' : 'Show ') + fieldName()",
    '[attr.aria-pressed]': 'visible()',
    '(click)': 'visible.update(invert)',
    '(window:blur)': 'visible.set(false)',
    '(document:visibilitychange)': 'visible.set(false)',
    '(window:agentkey-conceal)': 'visible.set(false)',
  },
})
export class PasswordToggle {
  readonly fieldName = input('password');
  // A reused row must not reveal a different field after its identity changes.
  readonly visible = linkedSignal(() => {
    this.fieldName();
    return false;
  });
  protected readonly invert = (value: boolean): boolean => !value;
}
