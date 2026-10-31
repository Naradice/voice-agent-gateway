pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        // Android 用の依存は Google の Maven にしかない。無関係なグループの問い合わせを送らないよう絞る。
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
    }
    // 使うときにだけ解決される(:app を含めない環境では、Android Gradle Plugin は取得されない)
    plugins {
        id("org.jetbrains.kotlin.jvm") version "2.0.21"
        id("org.jetbrains.kotlin.android") version "2.0.21"
        id("org.jetbrains.kotlin.plugin.serialization") version "2.0.21"
        id("org.jetbrains.kotlin.plugin.compose") version "2.0.21"
        id("com.android.application") version "8.7.3"
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
    }
}

rootProject.name = "voice-agent-client"

include(":core")

// Android SDK がある環境(Android Studio は local.properties を作る)でだけ :app を含める。
// SDK のない環境(CI や、この開発環境)では :core だけをビルド・テストできる。
if (file("local.properties").exists() || System.getenv("ANDROID_HOME") != null || System.getenv("ANDROID_SDK_ROOT") != null) {
    include(":app")
}
