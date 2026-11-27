package com.redisplay.client;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

final class SessionAuth {
    static void verify(DataInputStream in, DataOutputStream out, String hex) throws IOException {
        byte[] key = new byte[32];
        for (int i = 0; i < key.length; i++)
            key[i] = (byte) Integer.parseInt(hex.substring(2 * i, 2 * i + 2), 16);
        byte[] challenge = new byte[65];
        in.readFully(challenge, 1, 32);
        byte[] nonce = new byte[32];
        new SecureRandom().nextBytes(nonce);
        System.arraycopy(nonce, 0, challenge, 33, 32);
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            challenge[0] = 'A';
            out.write(nonce);
            out.write(mac.doFinal(challenge));
            out.flush();
            byte[] proof = new byte[32];
            in.readFully(proof);
            challenge[0] = 'W';
            if (!MessageDigest.isEqual(proof, mac.doFinal(challenge))) throw new IOException("Unexpected host");
        } catch (GeneralSecurityException e) {
            throw new IOException("Session authentication unavailable", e);
        } finally {
            java.util.Arrays.fill(key, (byte) 0);
        }
    }
}
