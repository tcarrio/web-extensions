import { ActionExtension, ApplicationSetupOptions } from '@opencloud-eu/web-pkg'
import { computed, unref } from 'vue'
import { usePaperlessActions } from './usePaperlessActions'

export const useExtensions = (args: ApplicationSetupOptions) => {
  const actions = usePaperlessActions(args)

  return computed<ActionExtension[]>(() =>
    unref(actions).map((action) => ({
      id: `com.github.tcarrio.web-extensions.paperless.${action.name}`,
      type: 'action',
      extensionPointIds: ['global.files.context-actions'],
      action
    }))
  )
}
