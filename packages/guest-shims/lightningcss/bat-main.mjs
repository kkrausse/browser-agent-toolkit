// ES entry: the same lazy functions as bat-main.cjs (one instance; this only re-exports).
import index from './bat-main.cjs';

const { transform, transformStyleAttribute, bundle, bundleAsync, browserslistToTargets, composeVisitors, Features } = index;
export { transform, transformStyleAttribute, bundle, bundleAsync, browserslistToTargets, composeVisitors, Features };
