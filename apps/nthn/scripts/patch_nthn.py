from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()


def replace(rel: str, old: str, new: str, count: int = 1) -> None:
    path = root / rel
    source = path.read_text()
    actual = source.count(old)
    if actual != count:
        raise RuntimeError(f'{rel}: expected {count} matches for {old!r}, found {actual}')
    path.write_text(source.replace(old, new))


replace('app/build.gradle', 'applicationId "com.termux"', 'applicationId "com.nthn"')
replace('app/build.gradle', 'manifestPlaceholders.TERMUX_PACKAGE_NAME = "com.termux"', 'manifestPlaceholders.TERMUX_PACKAGE_NAME = "com.nthn"')
replace('app/build.gradle', 'manifestPlaceholders.TERMUX_APP_NAME = "Termux"', 'manifestPlaceholders.TERMUX_APP_NAME = "nthn"')
replace('app/build.gradle', '        versionCode 1022\n', '        versionCode 1022\n\n        ndk { abiFilters "arm64-v8a" }\n')
replace('app/build.gradle', 'def downloadBootstrap(String arch, String expectedChecksum, String version) {', 'def downloadBootstrap(String arch, String expectedChecksum, String version) {\n    return // Use the custom ARM64 bootstrap supplied by this build.')
replace('app/src/main/res/values/strings.xml', '<!ENTITY TERMUX_PACKAGE_NAME "com.termux">', '<!ENTITY TERMUX_PACKAGE_NAME "com.nthn">')
replace('app/src/main/res/values/strings.xml', '<!ENTITY TERMUX_APP_NAME "Termux">', '<!ENTITY TERMUX_APP_NAME "nthn">')
replace('termux-shared/src/main/res/values/strings.xml', '<!ENTITY TERMUX_PACKAGE_NAME "com.termux">', '<!ENTITY TERMUX_PACKAGE_NAME "com.nthn">')
replace('termux-shared/src/main/res/values/strings.xml', '<!ENTITY TERMUX_APP_NAME "Termux">', '<!ENTITY TERMUX_APP_NAME "nthn">')
replace('termux-shared/src/main/res/values/strings.xml', '<!ENTITY TERMUX_PREFIX_DIR_PATH "/data/data/com.termux/files/usr">', '<!ENTITY TERMUX_PREFIX_DIR_PATH "/data/data/com.nthn/files/usr">')
replace('termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java', 'public static final String TERMUX_PACKAGE_NAME = "com.termux";', 'public static final String TERMUX_PACKAGE_NAME = "com.nthn";')
replace('termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java', 'public static final String BUILD_CONFIG_CLASS_NAME = TERMUX_PACKAGE_NAME + ".BuildConfig";', 'public static final String BUILD_CONFIG_CLASS_NAME = "com.termux.BuildConfig";')
replace('app/src/main/res/xml/shortcuts.xml', 'android:targetPackage="com.termux"', 'android:targetPackage="com.nthn"', 3)
print('Patched app package ID, shared paths, resources, and shortcuts for com.nthn')
