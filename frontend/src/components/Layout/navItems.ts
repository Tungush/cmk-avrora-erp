import {
  IconStack2,
  IconClipboardList,
  IconSettings,
  IconShoppingCart,
  IconPackage,
  IconBuildingBank,
  IconRuler2,
  IconTruckDelivery,
  IconHammer, IconTruck, IconCoin, IconBarcode,
} from '@tabler/icons-react';

export interface NavItem {
  to: string;
  icon: React.ComponentType<{ size?: number | string; stroke?: number }>;
  label: string;
  module: string;
  /** Короткая подпись для нижней панели: там одиннадцать пунктов в строку */
  short?: string;
}

/**
 * Единый список разделов (04.09.2026).
 *
 * До этого список жил внутри Sidebar. Когда появилась нижняя панель,
 * второй экземпляр списка означал бы два места, где надо не забыть про
 * права доступа: разошлись бы — и у кладовщика в одной панели четыре
 * пункта, а в другой одиннадцать. Список один, права проверяются один
 * раз тем же `canAccessModule`.
 *
 * Меню собирается из прав: у кладовщика останется 4 пункта, у
 * директора — все (§2.2).
 */
export const NAV_ITEMS: NavItem[] = [
  { to: '/', icon: IconClipboardList, label: 'Моя работа', module: 'work', short: 'Работа' },
  { to: '/orders', icon: IconShoppingCart, label: 'Заказы', module: 'orders' },
  // Объекты (базовые станции): телеком спрашивает про площадку, а не про
  // номер заказа — срез по project_site из 1С (02.09.2026)
  { to: '/sites', icon: IconStack2, label: 'Проекты', module: 'orders' },
  { to: '/production/kanban', icon: IconHammer, label: 'Цех', module: 'production' },
  // Подряд стал самостоятельным потоком (26.08.2026): заявка партией →
  // пачкой в Б24 → разнесение по заказам. До сих пор попасть сюда можно
  // было только с плитки «Моей работы», хотя это прямые деньги наружу
  { to: '/production/contractors', icon: IconTruck, label: 'Подряд', module: 'production' },
  { to: '/specs', icon: IconRuler2, label: 'Изделия', module: 'specs' },
  // НКТ — коды NTIN для изделий ЦМК (05.09.2026). Отдельный раздел, а не
  // вкладка «Изделий»: паспорт заводит инженер, а доработки, дубли и
  // отказы разбирает менеджер, и прав на нормы у него нет
  { to: '/nkt', icon: IconBarcode, label: 'НКТ', module: 'nkt' },
  // Прайс — коммерция, а не инженерия: цену видит тот, кто видит деньги заказа
  { to: '/prices', icon: IconCoin, label: 'Прайс', module: 'money' },
  { to: '/warehouse', icon: IconPackage, label: 'Материалы', module: 'materials' },
  { to: '/purchases', icon: IconTruckDelivery, label: 'Закупки', module: 'purchases' },
  { to: '/finance', icon: IconBuildingBank, label: 'Деньги', module: 'money' },
  { to: '/settings', icon: IconSettings, label: 'Настройки', module: 'settings' },
];
