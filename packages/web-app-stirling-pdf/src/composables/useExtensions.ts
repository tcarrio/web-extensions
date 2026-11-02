import { ActionExtension, ApplicationSetupOptions } from '@opencloud-eu/web-pkg'
import { computed, unref } from 'vue'
import { useStirlingActions } from './useStirlingActions'

export const useExtensions = (args: ApplicationSetupOptions) => {
  const actions = useStirlingActions(args)

  return computed<ActionExtension[]>(() =>
    unref(actions).map((action) => ({
      id: `com.github.tcarrio.web-extensions.stirling-pdf.${action.name}`,
      type: 'action',
      extensionPointIds: ['global.files.context-actions'],
      action
    }))
  )
}
