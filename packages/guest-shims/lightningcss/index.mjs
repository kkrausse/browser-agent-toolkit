// ES entry: the same lazy functions as index.js (one instance; this only re-exports).
import index from './index.js';

const { transform, transformStyleAttribute, bundle, bundleAsync, browserslistToTargets, composeVisitors, Features } = index;
export { transform, transformStyleAttribute, bundle, bundleAsync, browserslistToTargets, composeVisitors, Features };
