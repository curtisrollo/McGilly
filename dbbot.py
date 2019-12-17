import pandas as pd
import time
import datetime
from selenium import webdriver
import glob
import os


def read_csv():
    db = pd.read_csv('citiesdb.csv')
    city_names = db['city_ascii']
    scrape_value = db['scraped']
    count = len(scrape_value)
    city_list = []
    for (i, j) in zip(city_names, scrape_value):
        if j == 1:
            pass
        else:
            city_list.append(i)
    return city_list, count


def read_name_sendGrid_upload():
    city_list = []
    path = "/Users/curtisrollo/desktop/CSV/*.csv"
    for city_name in glob.glob(path):
        formatted_name = city_name.replace('/Users/curtisrollo/desktop/CSV/', '')
        city_list.append(formatted_name)
        print(formatted_name)
    return city_list



def create_output_csv(location, link, name, email):
    location_count = len(link)
    location_list = []
    for i in range(0, location_count):
        location_list.append(location)
    df = pd.DataFrame(location_list, columns=['Location'])
    df1 = pd.DataFrame(link, columns=['Link'])
    df2 = pd.DataFrame(name,  columns=['Name'])
    df3 = pd.DataFrame(email)
    data_frame = [df, df1, df2, df3]
    df = pd.concat(data_frame, axis=1)
    excel_name = location + ".xlsx"
    st_excel = "Excel/" + excel_name
    df.to_excel(st_excel, index=False)


def scrape_check(length_of_list):
    db = pd.read_csv('citiesdb.csv')
    db.at[length_of_list, 'scraped'] = '1'
    db.to_csv('citiesdb.csv', index=False)


def sendgrid_csv_prep(email_csv, location):
    email_list = []
    for i in email_csv:
        email_list.append(i)
        df = pd.DataFrame(email_list)
        df.to_csv('CSV/' + location + '.csv', index=False, header=['email'])



def add_csv_to_SendGrid(location):
    date = datetime.datetime.today()

    driver = webdriver.Chrome(executable_path='/usr/local/bin/chromedriver')
    driver.get('https://app.sendgrid.com/login')
    time.sleep(0)
    driver.find_element_by_id('usernameContainer-input-id').send_keys("curtisrollo")
    driver.find_element_by_id('passwordContainer-input-id').send_keys('Chocolate3!')
    time.sleep(0)
    driver.find_element_by_xpath('/html/body/div[3]/main/div[3]/div/div[1]/div/div[1]/div/form/div[4]/button').click()
    time.sleep(3)
    driver.get('https://sendgrid.com/marketing_campaigns/ui/contacts/upload_csv')
    time.sleep(3)
    driver.find_element_by_xpath('/html/body/div[3]/div/div/main/div[2]/div/article/div[2]/section[2]/article/div[1]/div[3]/label').click()
    driver.find_element_by_name('list-name').send_keys(location + '-SoundCloud-Artists-' + str(date.strftime('%d-%m-%Y')))
    time.sleep(1)
    driver.find_element_by_class_name('file-input').send_keys('/Users/curtisrollo/desktop/CSV/' + location)
    time.sleep(3)
    driver.find_element_by_class_name('pull-right').click()
    time.sleep(2)
    driver.find_element_by_class_name('btn-list').click()
    time.sleep(2)
    driver.close()
    os.rename('/Users/curtisrollo/desktop/CSV/' + location, '/Users/curtisrollo/desktop/finished/' + location)


if __name__ == '__main__':
    mcGilly_time = time.time()
    print("--- reading city names ---")
    city_names = read_name_sendGrid_upload()
    for location in city_names:
        add_csv_to_SendGrid(location)
        print("--- uploaded " + location + "---")
    print("--- %s seconds ---" % (time.time() - mcGilly_time))

master = pd.DataFrame()

