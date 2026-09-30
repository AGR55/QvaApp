plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseKeyStore = System.getenv("QVAAPPLY_ANDROID_KEYSTORE_PATH")

android {
    namespace = "com.qvaapply.sms"
    compileSdk = 35

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.qvaapply.sms"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.1.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    if (!releaseKeyStore.isNullOrBlank()) {
        signingConfigs {
            create("privateRelease") {
                storeFile = file(releaseKeyStore)
                storePassword = System.getenv("QVAAPPLY_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = "qvaapply"
                keyPassword = System.getenv("QVAAPPLY_ANDROID_KEYSTORE_PASSWORD")
            }
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("privateRelease")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.work:work-runtime-ktx:2.10.2")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    testImplementation("junit:junit:4.13.2")
}
