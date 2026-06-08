process.env.BUILD_LOCK_MODE = "acquire";
process.env.BUILD_LOCK_REGISTER_POST_CLEANUP = "1";
require("./build-lock.js").run();
