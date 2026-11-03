import { useGettext } from 'vue3-gettext'
import translations from '../l10n/translations.json'
import { AppWrapperRoute, defineWebApplication } from '@opencloud-eu/web-pkg'
import { useExtensions } from './composables/useExtensions'
import App from './App.vue'

const applicationId = 'stirling-pdf'

export default defineWebApplication({
  setup(args) {
    const { $gettext } = useGettext()
    const extensions = useExtensions(args)

    return {
      appInfo: {
        name: $gettext('Stirling PDF'),
        id: applicationId,
        icon: 'file-pdf-2',
        // Registers the app as an "Open With" target for PDFs: the route
        // is an operation launcher (App.vue), not an interactive editor —
        // Stirling has no file hand-in/hand-out protocol.
        defaultExtension: 'pdf',
        extensions: [
          {
            extension: 'pdf',
            routeName: 'stirling-pdf-editor'
          }
        ]
      },
      routes: [
        {
          name: 'stirling-pdf-editor',
          path: '/:driveAliasAndItem(.*)?',
          component: AppWrapperRoute(App, {
            applicationId,
            importResourceWithExtension() {
              return 'pdf'
            }
          }),
          meta: {
            authContext: 'hybrid',
            patchCleanPath: true
          }
        }
      ],
      translations,
      extensions
    }
  }
})
