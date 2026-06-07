process.env.BUILD_LOCK_MODE = "post-cleanup";
require("./build-lock.js").run();
