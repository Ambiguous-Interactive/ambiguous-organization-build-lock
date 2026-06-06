process.env.BUILD_LOCK_MODE = "acquire";
require("./build-lock.js").run();
