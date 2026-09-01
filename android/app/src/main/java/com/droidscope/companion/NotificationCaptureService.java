package com.droidscope.companion;

import android.app.Notification;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class NotificationCaptureService extends NotificationListenerService {
    private final ExecutorService background=Executors.newSingleThreadExecutor();
    @Override public void onNotificationPosted(StatusBarNotification item){
        if(!ApiClient.isEnrolled(this)||!getSharedPreferences("droidscope",MODE_PRIVATE).getBoolean("notificationSharing",false)||item.getPackageName().equals(getPackageName()))return;
        Notification n=item.getNotification();CharSequence title=n.extras.getCharSequence(Notification.EXTRA_TITLE);CharSequence text=n.extras.getCharSequence(Notification.EXTRA_TEXT);
        if((title==null||title.length()==0)&&(text==null||text.length()==0))return;
        JSONObject body=new JSONObject();try{body.put("app",item.getPackageName()).put("title",title==null?"":title.toString()).put("text",text==null?"":text.toString());}catch(Exception ignored){}
        background.execute(()->{try{ApiClient.post(this,"/api/agent/notification",body,true);}catch(Exception ignored){}});
    }
    @Override public void onDestroy(){background.shutdownNow();super.onDestroy();}
}
