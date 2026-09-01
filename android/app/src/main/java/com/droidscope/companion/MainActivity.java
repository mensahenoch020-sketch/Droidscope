package com.droidscope.companion;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ResolveInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class MainActivity extends Activity {
    private static final int PICK_PHOTO = 41;
    private static final int PICK_MESSAGE_BACKUP = 42;
    private final ExecutorService background = Executors.newSingleThreadExecutor();
    private SharedPreferences prefs;
    private TextView status;
    private EditText server;
    private EditText token;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("droidscope", MODE_PRIVATE);
        buildUi();
        if (ApiClient.isEnrolled(this)) { status.setText("Connected to your private dashboard"); showConnectedNotice(); heartbeat(); }
    }

    private void buildUi() {
        int pad = dp(22);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(pad,pad,pad,pad); root.setBackgroundColor(Color.rgb(6,16,11));
        TextView brand = text("DROIDSCOPE", 12, Color.rgb(57,224,121)); brand.setLetterSpacing(.16f); root.addView(brand);
        root.addView(text("Android Companion", 28, Color.WHITE));
        root.addView(text("Visible, owner-approved device testing. You can remove access at any time.", 15, Color.rgb(150,180,160)));

        status = text("Not connected", 15, Color.WHITE); status.setPadding(0,dp(20),0,dp(14)); root.addView(status);
        server = input("Dashboard HTTPS address"); server.setText(prefs.getString("serverUrl", BuildConfig.DEFAULT_SERVER_URL)); root.addView(server);
        token = input("One-time enrollment token"); root.addView(token);
        root.addView(button("Connect device", v -> enroll()));
        root.addView(button("1. Enable notification sharing", v -> enableNotificationSharing()));
        root.addView(button("Pause notification sharing", v -> { prefs.edit().putBoolean("notificationSharing",false).apply(); status.setText("Notification sharing paused on this Android"); }));
        root.addView(button("2. Share a selected photo", v -> choosePhoto()));
        root.addView(button("3. Run security scan", v -> securityScan()));
        root.addView(button("4. Audit launchable apps", v -> auditApps()));
        root.addView(button("5. Import message backup (JSON)", v -> chooseMessageBackup()));
        root.addView(button("Send test check-in", v -> heartbeat()));
        root.addView(button("Disconnect this companion", v -> disconnect()));
        TextView note = text("DroidScope does not bypass the lock screen, hide itself, or approve Android permissions for you. Notification previews are shared only after you enable Notification Access in Android Settings.", 13, Color.rgb(135,165,145)); note.setPadding(0,dp(18),0,0); root.addView(note);
        ScrollView scroll = new ScrollView(this); scroll.addView(root); setContentView(scroll);
    }

    private void enroll() {
        String base = server.getText().toString().trim(); String enrollment = token.getText().toString().trim();
        if (base.isEmpty() || enrollment.isEmpty()) { toast("Enter the dashboard address and temporary token."); return; }
        prefs.edit().putString("serverUrl", base).apply(); status.setText("Connecting…");
        background.execute(() -> {
            try {
                JSONObject body = new JSONObject().put("token", enrollment).put("name", Build.MANUFACTURER + " " + Build.MODEL).put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL).put("androidVersion", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT);
                JSONObject result = ApiClient.post(this, "/api/agent/enroll", body, false);
                prefs.edit().putString("deviceId", result.getString("deviceId")).putString("deviceSecret", result.getString("deviceSecret")).apply();
                runOnUiThread(() -> { status.setText("Connected successfully"); token.setText(""); showConnectedNotice(); });
            } catch (Exception error) { runOnUiThread(() -> { status.setText("Connection failed"); toast(error.getMessage()); }); }
        });
    }

    private void choosePhoto() {
        if (!ApiClient.isEnrolled(this)) { toast("Connect the device first."); return; }
        Intent intent;
        if (Build.VERSION.SDK_INT >= 33) intent = new Intent("android.provider.action.PICK_IMAGES").setType("image/*");
        else intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE);
        startActivityForResult(intent, PICK_PHOTO);
    }

    private void enableNotificationSharing(){
        prefs.edit().putBoolean("notificationSharing",true).apply();
        status.setText("Finish enabling Notification Access in Android Settings");
        startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"));
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode,resultCode,data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
        if (requestCode == PICK_MESSAGE_BACKUP) { importMessageBackup(data.getData()); return; }
        if (requestCode != PICK_PHOTO) return;
        Uri uri = data.getData(); status.setText("Sharing selected photo…");
        background.execute(() -> {
            try (InputStream input = getContentResolver().openInputStream(uri); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192]; int n; while ((n=input.read(buffer))>0) { output.write(buffer,0,n); if(output.size()>5_000_000) throw new IllegalStateException("Choose a photo smaller than 5 MB."); }
                String mime = getContentResolver().getType(uri); if (mime == null || !mime.startsWith("image/")) mime="image/jpeg";
                String encoded = "data:"+mime+";base64,"+Base64.encodeToString(output.toByteArray(),Base64.NO_WRAP);
                ApiClient.post(this,"/api/agent/photo",new JSONObject().put("name","Owner-selected photo").put("data",encoded),true);
                runOnUiThread(()->status.setText("Selected photo shared successfully"));
            } catch(Exception error){runOnUiThread(()->{status.setText("Photo was not shared");toast(error.getMessage());});}
        });
    }

    private void securityScan() {
        if (!ApiClient.isEnrolled(this)) { toast("Connect the device first."); return; }
        KeyguardManager keyguard=(KeyguardManager)getSystemService(KEYGUARD_SERVICE); DevicePolicyManager policy=(DevicePolicyManager)getSystemService(DEVICE_POLICY_SERVICE);
        boolean secure=keyguard!=null&&keyguard.isDeviceSecure(); boolean encrypted=policy!=null&&policy.getStorageEncryptionStatus()!=DevicePolicyManager.ENCRYPTION_STATUS_UNSUPPORTED&&policy.getStorageEncryptionStatus()!=DevicePolicyManager.ENCRYPTION_STATUS_INACTIVE;
        boolean dev=Settings.Global.getInt(getContentResolver(),Settings.Global.DEVELOPMENT_SETTINGS_ENABLED,0)==1; boolean adb=Settings.Global.getInt(getContentResolver(),Settings.Global.ADB_ENABLED,0)==1;
        JSONObject result=new JSONObject(); try{result.put("secureLock",secure).put("encrypted",encrypted).put("developerOptions",dev).put("adbEnabled",adb).put("sdk",Build.VERSION.SDK_INT).put("securityPatch",Build.VERSION.SECURITY_PATCH).put("testKeys",Build.TAGS!=null&&Build.TAGS.contains("test-keys"));}catch(Exception ignored){}
        status.setText("Running security scan…"); background.execute(()->{try{ApiClient.post(this,"/api/agent/scan",result,true);runOnUiThread(()->status.setText("Security scan completed"));}catch(Exception error){runOnUiThread(()->{status.setText("Scan upload failed");toast(error.getMessage());});}});
    }

    private void auditApps(){
        if(!ApiClient.isEnrolled(this)){toast("Connect the device first.");return;}
        status.setText("Auditing launchable applications…");
        background.execute(()->{
            try{
                Intent query=new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
                List<ResolveInfo> found=getPackageManager().queryIntentActivities(query,0);JSONArray apps=new JSONArray();Set<String> seen=new HashSet<>();
                for(ResolveInfo info:found){String packageName=info.activityInfo.packageName;if(!seen.add(packageName))continue;apps.put(new JSONObject().put("name",String.valueOf(info.loadLabel(getPackageManager()))).put("packageName",packageName));}
                JSONObject response=ApiClient.post(this,"/api/agent/apps",new JSONObject().put("apps",apps),true);int count=response.optInt("count",apps.length());
                runOnUiThread(()->status.setText("Audited "+count+" launchable applications"));
            }catch(Exception error){runOnUiThread(()->{status.setText("Application audit failed");toast(error.getMessage());});}
        });
    }

    private void chooseMessageBackup(){
        if(!ApiClient.isEnrolled(this)){toast("Connect the device first.");return;}
        Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE);startActivityForResult(intent,PICK_MESSAGE_BACKUP);
    }

    private void importMessageBackup(Uri uri){
        status.setText("Importing owner-selected message backup…");
        background.execute(()->{
            try(InputStream input=getContentResolver().openInputStream(uri);ByteArrayOutputStream output=new ByteArrayOutputStream()){
                byte[] buffer=new byte[8192];int n;while((n=input.read(buffer))>0){output.write(buffer,0,n);if(output.size()>2_000_000)throw new IllegalStateException("Choose a message backup smaller than 2 MB.");}
                String raw=output.toString("UTF-8").trim();JSONArray source=raw.startsWith("[")?new JSONArray(raw):new JSONObject(raw).getJSONArray("messages");JSONArray normalized=new JSONArray();
                for(int i=0;i<source.length()&&i<500;i++){JSONObject item=source.optJSONObject(i);if(item==null)continue;normalized.put(new JSONObject().put("sender",item.optString("sender",item.optString("from",""))).put("text",item.optString("text",item.optString("body",""))).put("messageAt",item.optLong("messageAt",item.optLong("timestamp",0))));}
                JSONObject response=ApiClient.post(this,"/api/agent/messages-import",new JSONObject().put("messages",normalized),true);int count=response.optInt("count",normalized.length());runOnUiThread(()->status.setText("Imported "+count+" owner-selected messages"));
            }catch(Exception error){runOnUiThread(()->{status.setText("Message backup was not imported");toast("Use the DroidScope JSON backup format. "+error.getMessage());});}
        });
    }

    private void heartbeat(){if(!ApiClient.isEnrolled(this))return;background.execute(()->{try{ApiClient.post(this,"/api/agent/heartbeat",new JSONObject(),true);runOnUiThread(()->status.setText("Connected to your private dashboard"));}catch(Exception error){runOnUiThread(()->status.setText("Dashboard connection unavailable"));}});}

    private void disconnect(){
        prefs.edit().remove("deviceId").remove("deviceSecret").apply();
        NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);manager.cancel(1001);
        status.setText("Disconnected on this Android");
        toast("Dashboard access has been removed from this companion.");
    }

    private void showConnectedNotice(){
        NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);String id="droidscope-status";
        if(Build.VERSION.SDK_INT>=26)manager.createNotificationChannel(new NotificationChannel(id,"DroidScope connection",NotificationManager.IMPORTANCE_LOW));
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=getPackageManager().PERMISSION_GRANTED)requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},7);
        PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        android.app.Notification notification=new android.app.Notification.Builder(this,id).setSmallIcon(android.R.drawable.ic_lock_idle_lock).setContentTitle("DroidScope is connected").setContentText("Tap to review or remove owner-approved access.").setContentIntent(open).setOngoing(true).build();
        manager.notify(1001,notification);
    }

    private EditText input(String hint){EditText x=new EditText(this);x.setHint(hint);x.setTextColor(Color.WHITE);x.setHintTextColor(Color.rgb(105,135,115));x.setSingleLine(true);x.setPadding(dp(14),dp(12),dp(14),dp(12));return x;}
    private Button button(String label, View.OnClickListener listener){Button b=new Button(this);b.setText(label);b.setOnClickListener(listener);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2);p.topMargin=dp(10);b.setLayoutParams(p);return b;}
    private TextView text(String value,int sp,int color){TextView t=new TextView(this);t.setText(value);t.setTextSize(sp);t.setTextColor(color);t.setGravity(Gravity.START);return t;}
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}private void toast(String text){Toast.makeText(this,text,Toast.LENGTH_LONG).show();}
}
