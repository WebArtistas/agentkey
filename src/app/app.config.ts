import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideTaiga } from '@taiga-ui/core';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideTaiga({ mode: 'light', scrollbars: 'native' }),
  ],
};
