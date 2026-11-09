import { Directive, signal } from '@angular/core';
import { tuiItemsHandlersProvider } from '@taiga-ui/core';
import type { ApprovalDuration } from '../../shared/contracts';

export const APPROVAL_DURATIONS: ApprovalDuration[] = ['once', 'hour', 'day', 'until-revoked'];
const labels: Record<ApprovalDuration, string> = {
  once: 'One attempt',
  hour: '1 hour',
  day: '24 hours',
  'until-revoked': 'Until revoked',
};

/** Keep the stored policy values unchanged while using readable labels in both review views. */
@Directive({
  selector: 'tui-textfield[appApprovalDuration]',
  providers: [
    tuiItemsHandlersProvider<ApprovalDuration>({
      stringify: signal((value: ApprovalDuration) => labels[value]),
    }),
  ],
})
export class ApprovalDurationOptions {}
