import { NextResponse } from 'next/server';
import clientPromise from '@/lib/mongodb';

export async function GET() {
  try {
    const client = await clientPromise;
    const db = client.db('madina_medicine_db'); // আপনার ডাটাবেজের নাম

    // ডাটাবেজ কানেকশন চেক করার কমান্ড
    await db.command({ ping: 1 });

    return NextResponse.json({ 
      success: true, 
      message: "আলহামদুলিল্লাহ! মঙ্গোডিবি ডাটাবেজ সফলভাবে কানেক্ট হয়েছে।" 
    });
  } catch (error: any) {
    return NextResponse.json({ 
      success: false, 
      error: error.message 
    }, { status: 500 });
  }
}