// The notification kinds this overlay build knows how to draw: kind -> view. Empty by default, so every kind renders
// with the generic card (src/notify/defaultView.jsx: `data.title`, `data.text`, and a Dismiss button).
//
// To add your own kinds, write a module that exports `views` and build with OVERLAY_VIEWS pointing at it, for example
//   OVERLAY_VIEWS=/path/to/my-views.jsx npm run overlay:dev      (use .jsx if the module contains JSX)
// (the README's "Adding a notification kind" has a complete example and the view contract). You don't edit this file.
export const views = {};
