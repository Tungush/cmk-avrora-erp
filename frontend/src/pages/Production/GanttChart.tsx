import React from 'react';
import type { Order } from '../../types';
import { differenceInDays, parseISO, addDays, format } from 'date-fns';
import { ru } from 'date-fns/locale';

interface GanttChartProps {
  orders: Order[];
}

export function GanttChart({ orders }: GanttChartProps) {
  if (!orders.length) return <div className="text-center text-slate-500 py-8">Нет активных заказов для отображения</div>;

  // Find min/max dates
  let minDate = new Date();
  let maxDate = new Date();
  
  orders.forEach(o => {
    const start = parseISO(o.requestDate);
    const end = o.plannedShipmentDate ? parseISO(o.plannedShipmentDate) : addDays(start, 14);
    if (start < minDate) minDate = start;
    if (end > maxDate) maxDate = end;
  });

  // Pad view by 7 days on each side
  minDate = addDays(minDate, -7);
  maxDate = addDays(maxDate, 7);
  const totalDays = differenceInDays(maxDate, minDate);

  const getLeftPct = (dateStr: string) => {
    const diff = differenceInDays(parseISO(dateStr), minDate);
    return Math.max(0, (diff / totalDays) * 100);
  };

  const getWidthPct = (startStr: string, endStr?: string) => {
    const start = parseISO(startStr);
    const end = endStr ? parseISO(endStr) : addDays(start, 14);
    const diff = differenceInDays(end, start);
    return Math.max(2, (diff / totalDays) * 100);
  };

  // Mock colors for Gantt bars based on status
  const statusColors: Record<string, string> = {
    DRAFT: '#94a3b8',
    CONFIRMED: '#3b82f6',
    IN_PRODUCTION: '#f59e0b',
    READY_TO_SHIP: '#06b6d4',
  };

  return (
    <div className="flex flex-col border border-slate-200 rounded-lg bg-white overflow-hidden">
      <div className="flex bg-slate-50 border-b border-slate-200 p-2 text-xs font-medium text-slate-500">
        <div className="w-48 shrink-0 border-r border-slate-200 pr-2">Заказ</div>
        <div className="flex-1 relative flex justify-between px-2">
          <span>{format(minDate, 'dd MMM', { locale: ru })}</span>
          <span>{format(maxDate, 'dd MMM', { locale: ru })}</span>
        </div>
      </div>
      
      <div className="flex flex-col max-h-[400px] overflow-y-auto">
        {orders.map(order => (
          <div key={order.id} className="flex border-b border-slate-100 min-h-[40px] items-center hover:bg-slate-50">
            <div className="w-48 shrink-0 px-2 text-sm truncate font-medium border-r border-slate-100" title={order.orderNumber}>
              {order.orderNumber}
            </div>
            <div className="flex-1 relative h-full flex items-center group">
              {/* Background grid lines could go here */}
              
              {/* Gantt Bar */}
              <div 
                className="absolute h-6 rounded-md shadow-sm transition-all cursor-grab active:cursor-grabbing flex items-center px-2 text-xs text-white font-medium overflow-hidden"
                style={{
                  left: `${getLeftPct(order.requestDate)}%`,
                  width: `${getWidthPct(order.requestDate, order.plannedShipmentDate)}%`,
                  backgroundColor: statusColors[order.status] || '#94a3b8',
                }}
                title={`План вывоза: ${order.plannedShipmentDate || 'Не задан'}`}
              >
                {order.customerName || order.customerId.substring(0,6)}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="p-2 bg-slate-50 text-xs text-slate-500 text-center italic">
        * Drag-n-drop сроки сохранются локально (API update в разработке)
      </div>
    </div>
  );
}
