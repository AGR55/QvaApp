plugins {
    id("com.google.gms.google-services")
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

val releaseKeyStore = System.getenv("QVAAPPLY_ANDROID_KEYSTORE_PATH")
val marketLogoSources = rootProject.layout.projectDirectory.dir("../public/icons")
val generatedMarketLogos = layout.buildDirectory.dir("generated/marketLogos/res")
val generateMarketLogos by tasks.registering(Exec::class) {
    val script = rootProject.layout.projectDirectory.file("scripts/generate_market_logos.py")
    inputs.file(script)
    inputs.files(listOf("cup.png", "tropical.png", "clasica.png", "qusd.png", "etecsa.svg", "zelle.svg").map { marketLogoSources.file(it) })
    outputs.dir(generatedMarketLogos)
    commandLine("python3", script.asFile.absolutePath, "--source", marketLogoSources.asFile.absolutePath,
        "--output", generatedMarketLogos.get().asFile.absolutePath)
}

android {
    namespace = "com.qvaapply.sms"
    compileSdk = 35
    buildFeatures { buildConfig = true; compose = true }
    sourceSets.getByName("main").res.srcDir(generatedMarketLogos)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.qvaapply.sms"
        minSdk = 26
        targetSdk = 35
        versionCode = 8
        versionName = "0.6.0"
        buildConfigField("boolean", "PAYMENT_FORM_ENABLED", "false")
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
    buildTypes.getByName("release") {
        isMinifyEnabled = true
        isShrinkResources = true
        proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
    }
    buildTypes.getByName("debug") {
        buildConfigField("boolean", "PAYMENT_FORM_ENABLED", "true")
    }
    buildTypes.create("lab") {
        initWith(buildTypes.getByName("debug"))
        applicationIdSuffix = ".lab"
        versionNameSuffix = "-lab"
        matchingFallbacks += "debug"
    }
    sourceSets.getByName("lab").java.srcDir("src/debug/java")
    sourceSets.getByName("testLab").java.srcDir("src/testDebug/java")
}

// Isolated laboratory has no Firebase registration, network permission or real tokens.
tasks.matching { it.name == "processLabGoogleServices" }.configureEach { enabled = false }

tasks.named("preBuild") { dependsOn(generateMarketLogos) }

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:34.19.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation(platform("androidx.compose:compose-bom:2025.08.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3:1.4.0")
    implementation("androidx.work:work-runtime-ktx:2.10.2")
    implementation("androidx.security:security-crypto:1.1.0")
    testImplementation("junit:junit:4.13.2")
}
