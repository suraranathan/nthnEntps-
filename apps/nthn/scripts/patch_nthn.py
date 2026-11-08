from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1]).resolve()
branding = Path(__file__).resolve().parent.parent / 'branding'


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
replace('termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java', 'public static final String TERMUX_APP_NAME = "Termux";', 'public static final String TERMUX_APP_NAME = "nthn";')
replace('termux-shared/src/main/java/com/termux/shared/termux/TermuxConstants.java', 'public static final String BUILD_CONFIG_CLASS_NAME = TERMUX_PACKAGE_NAME + ".BuildConfig";', 'public static final String BUILD_CONFIG_CLASS_NAME = "com.termux.BuildConfig";')
replace('app/src/main/res/xml/shortcuts.xml', 'android:targetPackage="com.termux"', 'android:targetPackage="com.nthn"', 3)

# Keep the terminal implementation and change only presentation resources.
replace('app/src/main/AndroidManifest.xml', '        android:banner="@drawable/banner"\n', '')
replace('app/src/main/AndroidManifest.xml', '''        <activity
            android:name=".app.TermuxActivity"''', '''        <activity
            android:name=".app.NthnActivity"
            android:exported="true"
            android:label="@string/application_name"
            android:launchMode="singleTask"
            android:theme="@style/Theme.TermuxApp.DayNight.NoActionBar">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>

        <activity
            android:name=".app.TermuxActivity"''')
replace('app/src/main/AndroidManifest.xml', '''            <intent-filter>
                <action android:name="android.intent.action.MAIN" />

                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />

                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
''', '')
replace('app/src/main/res/values/strings.xml', '<!ENTITY TERMUX_API_APP_NAME "Termux:API">', '<!ENTITY TERMUX_API_APP_NAME "nthn API">')
replace('app/src/main/res/values/strings.xml', '<!ENTITY TERMUX_BOOT_APP_NAME "Termux:Boot">', '<!ENTITY TERMUX_BOOT_APP_NAME "nthn Boot">')
replace('app/src/main/res/values/strings.xml', '<!ENTITY TERMUX_FLOAT_APP_NAME "Termux:Float">', '<!ENTITY TERMUX_FLOAT_APP_NAME "nthn Float">')
replace('app/src/main/res/values/strings.xml', '<!ENTITY TERMUX_STYLING_APP_NAME "Termux:Styling">', '<!ENTITY TERMUX_STYLING_APP_NAME "nthn Styling">')
replace('app/src/main/res/values/strings.xml', '<!ENTITY TERMUX_TASKER_APP_NAME "Termux:Tasker">', '<!ENTITY TERMUX_TASKER_APP_NAME "nthn Tasker">')
replace('app/src/main/res/values/strings.xml', '<!ENTITY TERMUX_WIDGET_APP_NAME "Termux:Widget">', '<!ENTITY TERMUX_WIDGET_APP_NAME "nthn Widget">')
replace('app/src/main/res/values/strings.xml', '<resources>\n', '<resources>\n    <string name="nthn_terminal_header">nthn  /  TERMINAL</string>\n')
replace('app/src/main/res/values/strings.xml', 'Add termux debug info to report?', 'Add nthn debug info to report?')
replace('app/src/main/res/values/strings.xml', 'TermuxService', 'terminal service', 6)
for extension in ('API', 'Boot', 'Float', 'Styling', 'Tasker', 'Widget'):
    replace('termux-shared/src/main/res/values/strings.xml', f'"Termux:{extension}"', f'"nthn {extension}"')
replace('termux-shared/src/main/res/values/strings.xml', 'Termux app crash report', 'nthn app crash report')
replace('termux-shared/src/main/res/values/strings.xml', 'official termux community forums', 'community forums')
replace('termux-shared/src/main/res/values/strings.xml', 'termux session command', 'terminal session command', 2)
replace('termux-shared/src/main/res/values/strings.xml', 'termux commands', 'terminal commands')
for variant in ('values', 'values-night'):
    theme = f'app/src/main/res/{variant}/themes.xml'
    old_drawer = '@color/white' if variant == 'values' else '@color/black'
    replace(theme, f'<item name="termuxActivityDrawerBackground">{old_drawer}</item>', '<item name="termuxActivityDrawerBackground">@color/nthn_panel</item>')
    if variant == 'values':
        replace(theme, '<item name="termuxActivityDrawerImageTint">@color/black</item>', '<item name="termuxActivityDrawerImageTint">@color/nthn_text</item>')
    replace(theme, '<item name="android:windowBackground">@color/black</item>', '<item name="android:windowBackground">@color/nthn_surface</item>')
    replace(theme, '<item name="extraKeysButtonActiveTextColor">@color/red_400</item>', '<item name="extraKeysButtonActiveTextColor">@color/white</item>')
    replace(theme, '<item name="extraKeysButtonBackgroundColor">@color/black</item>', '<item name="extraKeysButtonBackgroundColor">@color/nthn_surface</item>')
    replace(theme, '<item name="extraKeysButtonActiveBackgroundColor">@color/grey_500</item>', '<item name="extraKeysButtonActiveBackgroundColor">@color/nthn_selected</item>')

replace('app/src/main/res/layout/activity_termux.xml', 'android:background="@color/black"', 'android:background="@color/nthn_surface"')
replace('app/src/main/res/layout/activity_termux.xml', '''    <View
        android:id="@+id/activity_termux_bottom_space_view"''', '''    <include layout="@layout/nthn_bottom_nav" />

    <View
        android:id="@+id/activity_termux_bottom_space_view"''')
replace('app/src/main/res/layout/activity_termux.xml', '''                <LinearLayout
                    android:layout_width="match_parent"
                    android:layout_height="wrap_content"
                    android:orientation="horizontal">
                    <ImageButton''', '''                <LinearLayout
                    android:layout_width="match_parent"
                    android:layout_height="56dp"
                    android:gravity="center_vertical"
                    android:orientation="horizontal"
                    android:paddingStart="18dp"
                    android:paddingEnd="12dp">
                    <TextView
                        android:layout_width="0dp"
                        android:layout_height="wrap_content"
                        android:layout_weight="1"
                        android:text="@string/nthn_terminal_header"
                        android:textColor="@color/nthn_text"
                        android:textSize="16sp"
                        android:textStyle="bold" />
                    <ImageButton''')
replace('app/src/main/res/layout/item_terminal_sessions_list.xml', 'android:padding="6dip"', 'android:paddingStart="18dp"\n    android:paddingEnd="12dp"\n    android:paddingTop="8dp"\n    android:paddingBottom="8dp"')
replace('app/src/main/res/layout/view_terminal_toolbar_text_input.xml', 'android:textColor="@android:color/white"', 'android:textColor="@color/nthn_text"\n    android:background="@color/nthn_surface"')
replace('app/src/main/res/drawable/current_session_black.xml', '#212325', '#303030')
replace('app/src/main/res/drawable/session_ripple_black.xml', '@android:color/background_dark', '@color/nthn_panel')
replace('app/src/main/java/com/termux/app/activities/HelpActivity.java', 'import com.termux.shared.termux.TermuxConstants;\n', '')
replace('app/src/main/java/com/termux/app/activities/HelpActivity.java', '    WebView mWebView;', '    private static final String NTHN_HELP_URL = "file:///android_asset/nthn_help.html";\n\n    WebView mWebView;')
replace('app/src/main/java/com/termux/app/activities/HelpActivity.java', 'url.equals(TermuxConstants.TERMUX_WIKI_URL) || url.startsWith(TermuxConstants.TERMUX_WIKI_URL + "/")', 'url.equals(NTHN_HELP_URL)')
replace('app/src/main/java/com/termux/app/activities/HelpActivity.java', 'mWebView.loadUrl(TermuxConstants.TERMUX_WIKI_URL);', 'mWebView.loadUrl(NTHN_HELP_URL);')
replace('app/src/main/java/com/termux/app/TermuxActivity.java', '        setTermuxSessionsListView();', '        setTermuxSessionsListView();\n        NthnAiInstaller.install(this);')
replace('app/src/main/java/com/termux/app/TermuxActivity.java', '                    if (mTermuxService == null) return; // Activity might have been destroyed.', '                    if (mTermuxService == null) return; // Activity might have been destroyed.\n                    NthnAiInstaller.install(this);')
replace('app/src/main/java/com/termux/app/TermuxActivity.java', '        setActivityTheme();', '        setActivityTheme();\n        NthnTheme.apply(this);')
replace('app/src/main/java/com/termux/app/TermuxActivity.java', '        setContentView(R.layout.activity_termux);', '        setContentView(R.layout.activity_termux);\n        NthnNavigation.attach(this, R.id.nav_terminal);')

for source in branding.rglob('*'):
    if source.is_file():
        target = root / source.relative_to(branding)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)

replace('app/src/main/AndroidManifest.xml', '<application', '<application\n        android:usesCleartextTraffic="false"', 1)
replace('app/src/main/res/layout/activity_nthn.xml', '        android:layout_height="0dp"\n        android:layout_weight="1" />', '        android:layout_height="match_parent" />')

# Load the NTHN preview as the native dashboard's WebView document.
replace('app/src/main/res/layout/activity_nthn.xml', '''    <TextView
        android:id="@+id/nthn_title"''', '''    <TextView
        android:id="@+id/nthn_title"''')
replace('app/src/main/res/layout/activity_nthn.xml', '''        android:background="@color/nthn_surface"
        android:fitsSystemWindows="true"
        android:orientation="vertical">''', '''        android:background="@color/nthn_surface"
        android:fitsSystemWindows="true"
        android:orientation="vertical">''')

provider_sources = Path(__file__).resolve().parents[3] / 'apps/dashboard/server/ai'
provider_assets = root / 'app/src/main/assets/nthn-ai/server/ai'
provider_assets.mkdir(parents=True, exist_ok=True)
for source in provider_sources.glob('*.ts'):
    shutil.copyfile(source, provider_assets / source.name)

chat_ui = Path(__file__).resolve().parents[3] / 'apps/nthn/ui-preview/index.html'
shutil.copyfile(chat_ui, root / 'app/src/main/assets/nthn_chat.html')

# The density-specific upstream icons otherwise remain eligible on older Android versions.
for icon in (root / 'app/src/main/res').glob('mipmap-*/ic_launcher*.png'):
    icon.unlink()
(root / 'app/src/main/res/drawable/banner.png').unlink()

print('Patched com.nthn identity and monochrome nthn interface')
