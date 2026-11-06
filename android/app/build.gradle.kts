import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

data class ReleaseKey(val storeFile: File, val storePassword: String, val keyAlias: String, val keyPassword: String)

fun env(name: String): String? = providers.environmentVariable(name).orNull

fun releaseKey(): ReleaseKey? {
    env("SETI_ANDROID_KEYSTORE")?.let { path ->
        val storePassword = requireNotNull(env("SETI_ANDROID_KEYSTORE_PASSWORD"))
        return ReleaseKey(
            file(path),
            storePassword,
            requireNotNull(env("SETI_ANDROID_KEY_ALIAS")),
            env("SETI_ANDROID_KEY_PASSWORD") ?: storePassword,
        )
    }
    val path = env("SETI_ANDROID_SIGNING")
        ?: "${System.getProperty("user.home")}/.seti/android/signing.properties"
    val source = file(path)
    if (!source.isFile) return null
    val props = Properties().apply { source.inputStream().use(::load) }
    val store = source.parentFile.resolve(props.getProperty("storeFile"))
    return ReleaseKey(
        store,
        props.getProperty("storePassword"),
        props.getProperty("keyAlias"),
        props.getProperty("keyPassword") ?: props.getProperty("storePassword"),
    )
}

val appLinkHost: String? = providers.gradleProperty("seti.host").orNull?.takeIf { it.isNotBlank() }

val releaseVersionCode: Int = providers.gradleProperty("seti.versionCode").map(String::toInt).getOrElse(1)
val releaseVersionName: String = providers.gradleProperty("seti.versionName").getOrElse("0.1.0")

android {
    namespace = "dev.seti.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "dev.seti.android"
        minSdk = 28
        targetSdk = 37
        versionCode = releaseVersionCode
        versionName = releaseVersionName
        appLinkHost?.let { manifestPlaceholders["setiHost"] = it }
    }

    signingConfigs {
        releaseKey()?.let { key ->
            create("release") {
                storeFile = key.storeFile
                storePassword = key.storePassword
                keyAlias = key.keyAlias
                keyPassword = key.keyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion")
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
        unitTests.isIncludeAndroidResources = true
    }
}

if (appLinkHost != null) {
    androidComponents.onVariants { it.sources.manifests.addStaticManifestFile("applinks/AndroidManifest.xml") }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.glance.appwidget)
    implementation(libs.androidx.glance.material3)
    implementation(libs.androidx.work.runtime)
    implementation(libs.androidbrowserhelper)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.play.services.code.scanner)

    testImplementation(libs.androidx.test.core)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.robolectric)
}

val widgetPreviews: String? = providers.gradleProperty("seti.widgetPreviews").orNull

tasks.withType<Test>().configureEach {
    widgetPreviews?.let { systemProperty("seti.widgetPreviews", it) }
}
