export default defineAppConfig({
  ui: {
    colors: {
      primary: "creup-red",
      secondary: "creup-blue",
    },
    toast: {
      slots: {
        title: "text-sm font-medium text-highlighted select-text",
        description: "text-sm text-muted select-text",
      },
    },
  },
});
