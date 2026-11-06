-keep class dev.seti.android.widget.RefreshAction { <init>(); }
# ML Kit creates its registrars by reflection; R8 full mode drops their constructors otherwise.
-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }
