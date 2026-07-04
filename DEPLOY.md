# คู่มือ Deploy ขึ้น Render (ฟรี)

แอปนี้เป็น JHCIS dashboard แบบ **อ่านอย่างเดียว** (SELECT เท่านั้น ไม่แก้ไขข้อมูล JHCIS)
คู่มือนี้พา deploy ขึ้น Render โดยไม่กระทบระบบ JHCIS เดิม

---

## ⚠️ อ่านก่อน 2 ข้อ

1. **ข้อมูลคนไข้ (PDPA):** JHCIS มีข้อมูลสุขภาพส่วนบุคคล การนำขึ้นคลาวด์ต่างประเทศ
   ควรได้รับอนุญาตจากผู้ดูแลระบบ / ผอ.รพ.สต. ก่อน
2. **Render ต้องต่อ MySQL ให้ได้:** Render อยู่บนคลาวด์ จึงต้อง "มองเห็น" MySQL ของ JHCIS
   ถ้า DB อยู่ในวงแลน รพ.สต. ต้องทำ tunnel ก่อน → ดู **ภาคผนวก A**

---

## ขั้นตอน

### 1) เตรียม code บน GitHub
โค้ดอยู่ที่ `github.com/PimonwunPhoomsrikaew/Revenue` แล้ว ตรวจว่าได้ push ไฟล์ใหม่ขึ้นไปด้วย:
```bash
git add package.json render.yaml DEPLOY.md
git commit -m "Add Render deploy config"
git push origin main
```
> หมายเหตุ: `.env` จะ **ไม่** ถูก push (อยู่ใน `.gitignore` แล้ว) — ค่าลับไปตั้งในหน้า Render แทน

### 2) สมัคร Render
- ไปที่ https://render.com → **Get Started** → login ด้วย GitHub
- อนุญาตให้ Render เข้าถึง repo `Revenue`

### 3) สร้าง service ด้วย Blueprint (วิธีที่ง่ายสุด)
1. กดเมนู **New +** (มุมขวาบน) → **Blueprint**
2. เลือก repo `PimonwunPhoomsrikaew/Revenue`
3. Render จะอ่าน `render.yaml` อัตโนมัติ แล้วแสดง service ชื่อ `jhcis-revenue-dashboard`
4. กด **Apply**

> ทางเลือก (ไม่ใช้ Blueprint): New + → **Web Service** → เลือก repo →
> ตั้ง Build Command = `npm install`, Start Command = `npm start`, Plan = **Free**

### 4) ตั้งค่า Environment Variables
หลังสร้าง service ไปที่แท็บ **Environment** แล้วใส่ค่า (ปุ่ม Add Environment Variable):

| Key           | ค่าที่ใส่                                  |
|---------------|--------------------------------------------|
| `APP_USER`    | ชื่อผู้ใช้ที่ต้องการ login เข้า dashboard   |
| `APP_PASS`    | รหัสผ่านที่ต้องการ (ตั้งให้แข็งแรง)         |
| `DB_HOST`     | host/IP ของ MySQL JHCIS (ดูภาคผนวก A)      |
| `DB_PORT`     | `3306` (ตั้งให้แล้วใน blueprint)            |
| `DB_USER`     | user ของ MySQL JHCIS (แนะนำสิทธิ์ SELECT)  |
| `DB_PASSWORD` | รหัสผ่าน MySQL                             |
| `DB_NAME`     | ชื่อฐานข้อมูล JHCIS (เช่น `jhcisdb`)        |

> `SESSION_SECRET` ไม่ต้องตั้ง — `render.yaml` สั่ง Render สุ่มให้เอง
> `PORT` ไม่ต้องตั้ง — Render กำหนดให้อัตโนมัติ

กด **Save Changes** → Render จะ deploy ใหม่ให้เอง

### 5) เปิดใช้งาน
- รอ build เสร็จ (~1-2 นาที) สถานะขึ้น **Live**
- เปิด URL ที่ได้ เช่น `https://jhcis-revenue-dashboard.onrender.com`
- login ด้วย `APP_USER` / `APP_PASS` ที่ตั้งไว้
- ถ้าหน้า dashboard ขึ้นข้อมูล = ต่อ DB สำเร็จ ✅
  ถ้าขึ้น error `ECONNREFUSED` / `ETIMEDOUT` = Render ยังต่อ MySQL ไม่ได้ → ดูภาคผนวก A

---

## ข้อจำกัดของแผนฟรี (Free plan)
- **หลับเมื่อไม่มีคนใช้ 15 นาที** — request แรกหลังหลับจะช้า ~30-50 วิ (cold start)
  ถ้าอยากให้ตื่นตลอด: ใช้ UptimeRobot ping `/api/me` ทุก 10 นาที (ฟรี)
- โควต้า **750 ชม./เดือน** (พอสำหรับ 1 service รันต่อเนื่อง)
- **session เก็บใน memory** — ทุกครั้งที่ Render restart/deploy ผู้ใช้จะหลุด login
  (ใช้งานทั่วไปไม่เป็นไร แค่ต้อง login ใหม่)

---

## ภาคผนวก A — ทำให้ Render ต่อ MySQL ของ รพ.สต. ได้

MySQL JHCIS มักอยู่ในวงแลนภายใน Render มองไม่เห็น เลือกวิธีใดวิธีหนึ่ง:

### วิธีที่แนะนำ: Cloudflare Tunnel (ฟรี, ไม่ต้องเปิด port สาธารณะ)
รันที่ "เครื่องในวงแลนที่ต่อ MySQL ได้" (เช่นเครื่อง server JHCIS เอง):
```bash
# ติดตั้ง cloudflared แล้ว login
cloudflared tunnel login
cloudflared tunnel create jhcis-db
# ชี้ tunnel ไปที่ MySQL ในเครื่อง
cloudflared tunnel route ... # ตั้ง public hostname เช่น db.example.com -> tcp://localhost:3306
cloudflared tunnel run jhcis-db
```
แล้วตั้ง `DB_HOST` = hostname ของ tunnel
> Cloudflare Tunnel แบบ TCP ต้องใช้ฝั่ง client `cloudflared access tcp` — ถ้าซับซ้อนเกินไป ใช้ Tailscale ด้านล่างจะง่ายกว่า

### วิธีที่ง่ายกว่า: Tailscale (VPN ส่วนตัว ฟรี)
1. ติดตั้ง Tailscale บนเครื่อง MySQL → ได้ IP ในวง `100.x.x.x`
2. เนื่องจาก Render ต่อ Tailscale โดยตรงไม่ได้ ให้ใช้ **Tailscale Funnel** หรือทำเครื่อง relay
   (เหมาะกรณีมี VPS เล็ก ๆ เป็นตัวกลาง)

### วิธีที่เร็วที่สุดสำหรับ "ลองดูก่อน": ย้าย DB ขึ้นคลาวด์ฟรี
ถ้าแค่อยากเดโม/ทดสอบ ไม่ใช่ข้อมูล production:
- สร้าง MySQL ฟรีที่ **Aiven** หรือ **TiDB Cloud Serverless** หรือ **Clever Cloud**
- export ข้อมูลที่ต้องใช้จาก JHCIS แล้ว import เข้าฐานใหม่
- ตั้ง `DB_HOST/DB_USER/...` ชี้มาที่ฐานคลาวด์นั้น
- ข้อดี: Render ต่อได้ทันที ไม่ต้องแตะวงแลน รพ.สต.

> ❌ **อย่า** เปิด port 3306 ของ MySQL JHCIS ออกอินเทอร์เน็ตตรง ๆ — เสี่ยงข้อมูลคนไข้รั่ว

---

## สรุปไฟล์ที่เพิ่มเข้ามา
- `render.yaml` — Blueprint บอก Render ว่าจะ build/run อย่างไร
- `package.json` — เพิ่ม `start` script และ Node version
- `DEPLOY.md` — คู่มือนี้
